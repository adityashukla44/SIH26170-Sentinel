from collections import Counter
from time import perf_counter

import numpy as np
import pandas as pd

from app.drift_model import row_fingerprint
from app.prediction_engine import (
    model_status,
    predict_168h_batch,
    training_fingerprints,
)


REQUIRED_COLUMNS = [
    "Component_ID",
    "Temperature",
    "Voltage",
    "Current_0h",
    "Current_24h",
    "Current_96h",
    "Current_168h",
]

NUMERIC_COLUMNS = REQUIRED_COLUMNS[1:]

CURRENT_COLUMNS = [
    "Current_0h",
    "Current_24h",
    "Current_96h",
    "Current_168h",
]

BURN_IN_HOURS = [0, 24, 96, 168]

# Optional ground-truth column. It is never used for scoring, only to
# report how the screening decisions line up with known labels.
LABEL_COLUMN = "Label"

DECISIONS = ["PASS", "REVIEW", "FAIL"]

# Weighted anomaly signals: (key, label, weight).
SIGNAL_WEIGHTS = [
    ("deviation", "Deviation from batch mean", 0.30),
    ("median", "Deviation from batch median", 0.20),
    ("z_score", "Statistical outlier (z-score)", 0.15),
    ("drift", "Total burn-in drift", 0.20),
    ("prediction", "Forecast growth after 24 h", 0.15),
]

REVIEW_THRESHOLD = 35
FAIL_THRESHOLD = 70


def validate_dataset(df: pd.DataFrame) -> None:
    missing = [
        column for column in REQUIRED_COLUMNS
        if column not in df.columns
    ]

    if missing:
        raise ValueError(
            f"Missing required columns: {', '.join(missing)}"
        )

    if df.empty:
        raise ValueError("Dataset is empty.")

    for column in NUMERIC_COLUMNS:
        if not pd.api.types.is_numeric_dtype(df[column]):
            raise ValueError(
                f"Column '{column}' must contain numeric values."
            )

    missing_values = [
        column for column in REQUIRED_COLUMNS
        if df[column].isna().any()
    ]

    if missing_values:
        raise ValueError(
            "Missing values found in: " + ", ".join(missing_values)
        )

    if df["Component_ID"].duplicated().any():
        raise ValueError("Duplicate Component_ID values found.")


def calculate_batch_statistics(df: pd.DataFrame) -> dict:
    validate_dataset(df)

    return {
        "component_count": int(len(df)),
        "mean_current_0h": round(df["Current_0h"].mean(), 4),
        "mean_current_24h": round(df["Current_24h"].mean(), 4),
        "mean_current_96h": round(df["Current_96h"].mean(), 4),
        "mean_current_168h": round(df["Current_168h"].mean(), 4),
        "std_current_168h": round(
            df["Current_168h"].std(ddof=0), 4
        ),
    }


def get_component(df: pd.DataFrame, component_id: str) -> dict:
    matches = df[
        df["Component_ID"].astype(str) == str(component_id)
    ]

    if matches.empty:
        raise ValueError(
            f"Component '{component_id}' was not found in the dataset."
        )

    return matches.iloc[0].to_dict()


def _ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator != 0 else 0.0


def _batch_reference(df: pd.DataFrame) -> dict:
    values_168h = df["Current_168h"].astype(float)

    return {
        "size": int(len(df)),
        "average": float(values_168h.mean()),
        "median": float(values_168h.median()),
        "std": float(values_168h.std(ddof=0)),
    }


def _clean_label(value) -> str | None:
    if value is None or pd.isna(value):
        return None

    text = str(value).strip()
    return text or None


def _analyze_row(
    component: dict,
    reference: dict,
    prediction: tuple[float, str],
) -> dict:
    batch_average = reference["average"]
    batch_median = reference["median"]
    batch_std = reference["std"]

    component_value = float(component["Current_168h"])

    # Observed deviation at 168h.
    deviation_percent = _ratio(
        component_value - batch_average, batch_average
    ) * 100

    median_deviation_percent = _ratio(
        component_value - batch_median, batch_median
    ) * 100

    # Classical z-score.
    z_score = (
        (component_value - batch_average) / batch_std
        if batch_std > 0
        else 0.0
    )

    current_0h = float(component["Current_0h"])
    current_24h = float(component["Current_24h"])
    current_96h = float(component["Current_96h"])
    current_168h = float(component["Current_168h"])

    # Multi-stage drift.
    drift_0_24 = _ratio(current_24h - current_0h, current_0h)
    drift_24_96 = _ratio(current_96h - current_24h, current_24h)
    drift_96_168 = _ratio(current_168h - current_96h, current_96h)
    total_drift = _ratio(current_168h - current_0h, current_0h)

    # Future prediction.
    predicted_168h, prediction_source = prediction

    predicted_deviation_percent = _ratio(
        predicted_168h - batch_median, batch_median
    ) * 100

    predicted_growth_from_24h = _ratio(
        predicted_168h - current_24h, current_24h
    )

    # -------------------------
    # Dynamic anomaly signals
    # -------------------------

    signal_values = {
        "deviation": min(abs(deviation_percent) / 100.0, 1.0),
        "median": min(abs(median_deviation_percent) / 150.0, 1.0),
        "z_score": min(abs(z_score) / 3.0, 1.0),
        "drift": min(abs(total_drift) / 1.0, 1.0),
        "prediction": min(abs(predicted_growth_from_24h) / 1.0, 1.0),
    }

    signal_inputs = {
        "deviation": (deviation_percent, "%"),
        "median": (median_deviation_percent, "%"),
        "z_score": (z_score, "σ"),
        "drift": (total_drift * 100, "%"),
        "prediction": (predicted_growth_from_24h * 100, "%"),
    }

    # Combined score.
    base_score = sum(
        weight * signal_values[key]
        for key, _, weight in SIGNAL_WEIGHTS
    ) * 100

    anomaly_score = base_score
    overrides = []

    # Strong evidence overrides.
    floors = [
        (abs(deviation_percent) >= 100, 80,
         "168h current is at least 100% away from the batch mean"),
        (abs(deviation_percent) >= 200, 90,
         "168h current is at least 200% away from the batch mean"),
        (total_drift >= 1.0, 75,
         "Current at least doubled during burn-in"),
        (predicted_growth_from_24h >= 1.0, 75,
         "Forecast 168h current is at least double the 24h reading"),
    ]

    for condition, floor, description in floors:
        if condition and anomaly_score < floor:
            anomaly_score = floor
            overrides.append(
                {"floor": floor, "description": description}
            )

    anomaly_score = round(
        min(max(anomaly_score, 0.0), 100.0),
        2,
    )

    # -------------------------
    # Explainability
    # -------------------------

    reasons = []

    if abs(deviation_percent) >= 50:
        reasons.append(
            "168h current is significantly different "
            "from the batch average"
        )

    if abs(median_deviation_percent) >= 50:
        reasons.append(
            "Component is significantly different "
            "from typical batch behavior"
        )

    if abs(z_score) >= 2:
        reasons.append(
            "Component shows statistically unusual behavior"
        )

    if total_drift >= 0.20:
        reasons.append(
            "Strong positive current drift detected over burn-in"
        )

    if drift_24_96 > 0.20 or drift_96_168 > 0.20:
        reasons.append(
            "Rapid late-stage drift detected"
        )

    if predicted_growth_from_24h >= 0.30:
        reasons.append(
            "Predicted 168h value indicates continued upward drift"
        )

    if predicted_deviation_percent >= 50:
        reasons.append(
            "Predicted 168h value is significantly above "
            "typical batch behavior"
        )

    if not reasons:
        reasons.append(
            "Component behavior is within expected batch variation"
        )

    # -------------------------
    # Final decision
    # -------------------------

    if anomaly_score >= FAIL_THRESHOLD:
        risk_level = "HIGH"
        decision = "FAIL"
    elif anomaly_score >= REVIEW_THRESHOLD:
        risk_level = "MEDIUM"
        decision = "REVIEW"
    else:
        risk_level = "LOW"
        decision = "PASS"

    escalation = None

    # Future-risk escalation.
    if predicted_growth_from_24h >= 1.0:
        if decision != "FAIL":
            escalation = (
                "Forecast growth of 100% or more after 24 h "
                f"escalated {decision} to FAIL"
            )
        risk_level = "HIGH"
        decision = "FAIL"
    elif predicted_growth_from_24h >= 0.50 and risk_level == "LOW":
        escalation = (
            "Forecast growth of 50% or more after 24 h "
            "escalated PASS to REVIEW"
        )
        risk_level = "MEDIUM"
        decision = "REVIEW"

    signals = [
        {
            "key": key,
            "label": label,
            "weight": weight,
            "input": round(signal_inputs[key][0], 3),
            "input_unit": signal_inputs[key][1],
            "signal": round(signal_values[key], 4),
            "points": round(weight * signal_values[key] * 100, 2),
            "max_points": round(weight * 100, 2),
        }
        for key, label, weight in SIGNAL_WEIGHTS
    ]

    return {
        "component_id": str(component["Component_ID"]),
        "batch_size": reference["size"],
        "batch_average_168h": round(batch_average, 4),
        "batch_median_168h": round(batch_median, 4),
        "batch_std_168h": round(batch_std, 4),
        "component_value_168h": round(component_value, 4),
        "deviation_percent": round(deviation_percent, 2),
        "median_deviation_percent": round(
            median_deviation_percent, 2
        ),
        "z_score": round(z_score, 3),
        "drift_0_24": round(drift_0_24, 4),
        "drift_24_96": round(drift_24_96, 4),
        "drift_96_168": round(drift_96_168, 4),
        "total_drift": round(total_drift, 4),
        "predicted_168h": predicted_168h,
        "prediction_source": prediction_source,
        "predicted_deviation_percent": round(
            predicted_deviation_percent,
            2,
        ),
        "predicted_growth_from_24h": round(
            predicted_growth_from_24h,
            4,
        ),
        "anomaly_score": anomaly_score,
        "risk_level": risk_level,
        "decision": decision,
        "reasons": reasons,
        # Extra context for dashboards.
        "temperature": round(float(component["Temperature"]), 4),
        "voltage": round(float(component["Voltage"]), 4),
        "current_0h": round(current_0h, 4),
        "current_24h": round(current_24h, 4),
        "current_96h": round(current_96h, 4),
        "current_168h": round(current_168h, 4),
        "label": _clean_label(component.get(LABEL_COLUMN)),
        "score_breakdown": {
            "signals": signals,
            "base_score": round(base_score, 2),
            "overrides": overrides,
            "escalation": escalation,
            "review_threshold": REVIEW_THRESHOLD,
            "fail_threshold": FAIL_THRESHOLD,
        },
    }


def analyze_component_against_batch(
    df: pd.DataFrame,
    component_id: str,
) -> dict:

    validate_dataset(df)

    component = get_component(df, component_id)
    reference = _batch_reference(df)

    prediction = predict_168h_batch(
        [component["Current_0h"]],
        [component["Current_24h"]],
    )[0]

    result = _analyze_row(component, reference, prediction)
    result["component_id"] = str(component_id)

    return result


def _trajectory(df: pd.DataFrame) -> dict:
    """Batch spread at each burn-in checkpoint, for charts."""

    quantiles = {
        "p10": 0.10,
        "p25": 0.25,
        "median": 0.50,
        "p75": 0.75,
        "p90": 0.90,
    }

    trajectory = {"hours": BURN_IN_HOURS}

    for name, q in quantiles.items():
        trajectory[name] = [
            round(float(df[column].quantile(q)), 4)
            for column in CURRENT_COLUMNS
        ]

    trajectory["mean"] = [
        round(float(df[column].mean()), 4)
        for column in CURRENT_COLUMNS
    ]
    trajectory["min"] = [
        round(float(df[column].min()), 4)
        for column in CURRENT_COLUMNS
    ]
    trajectory["max"] = [
        round(float(df[column].max()), 4)
        for column in CURRENT_COLUMNS
    ]

    return trajectory


def _label_order(label: str) -> tuple[int, str]:
    text = label.lower()

    if "healthy" in text or text in {"good", "pass", "normal"}:
        return 0, text
    if "noise" in text or "edge" in text:
        return 1, text
    if "latent" in text:
        return 2, text
    if "defect" in text or "fail" in text:
        return 3, text

    return 4, text


def _evaluate_against_labels(results: list[dict]) -> dict | None:
    labelled = [r for r in results if r["label"]]

    if not labelled:
        return None

    labels = sorted({r["label"] for r in labelled}, key=_label_order)

    matrix = []

    for label in labels:
        rows = [r for r in labelled if r["label"] == label]
        counts = Counter(r["decision"] for r in rows)
        matrix.append({
            "label": label,
            "total": len(rows),
            "counts": {d: counts.get(d, 0) for d in DECISIONS},
        })

    def is_defect(label: str) -> bool:
        text = label.lower()
        return "defect" in text or "fail" in text

    def is_healthy(label: str) -> bool:
        text = label.lower()
        return "healthy" in text or text in {"good", "pass", "normal"}

    defects = [r for r in labelled if is_defect(r["label"])]
    healthy = [r for r in labelled if is_healthy(r["label"])]

    defects_flagged = sum(r["decision"] != "PASS" for r in defects)
    healthy_flagged = sum(r["decision"] != "PASS" for r in healthy)

    return {
        "label_column": LABEL_COLUMN,
        "labels": labels,
        "matrix": matrix,
        "defect_count": len(defects),
        "defects_flagged": defects_flagged,
        "detection_rate": (
            round(defects_flagged / len(defects) * 100, 2)
            if defects else None
        ),
        "healthy_count": len(healthy),
        "healthy_flagged": healthy_flagged,
        "false_alarm_rate": (
            round(healthy_flagged / len(healthy) * 100, 2)
            if healthy else None
        ),
    }


def _forecast_check(df: pd.DataFrame, results: list[dict]) -> dict:
    """Compare the 168h forecast with the measured 168h current.

    The forecast only sees the 0h and 24h readings, so the measured 168h
    value in the CSV is an honest yardstick for it.
    """

    actual = df["Current_168h"].astype(float).to_numpy()
    predicted = np.array([r["predicted_168h"] for r in results], dtype=float)
    errors = np.abs(predicted - actual)
    count = len(results)

    rounded = Counter(round(float(p), 2) for p in predicted)
    common_value, common_count = rounded.most_common(1)[0]
    common_share = common_count / count * 100

    sources = Counter(r["prediction_source"] for r in results)
    outside = sources.get("FALLBACK_OUT_OF_RANGE", 0)
    ml_share = sources.get("ML_MODEL", 0) / count * 100

    status = model_status()
    training = status.get("training") or {}

    # How much of this batch the model was trained on. Error measured on
    # those rows is in-sample; the cross-validated figure is the honest one.
    fingerprints = training_fingerprints()
    overlap = None
    if fingerprints:
        seen = sum(
            row_fingerprint(r.Current_0h, r.Current_24h, r.Current_96h, r.Current_168h)
            in fingerprints
            for r in df.itertuples(index=False)
        )
        overlap = round(seen / count * 100, 1)

    mae = float(errors.mean())
    median_error = float(np.median(errors))
    median_actual = float(np.median(actual))

    warnings = []

    if count >= 10 and common_share >= 50:
        warnings.append(
            f"{common_share:.0f}% of components received the same 168h "
            f"forecast ({common_value:g} µA). The model is not responding "
            "to these readings."
        )

    if outside >= max(1, 0.25 * count):
        warnings.append(
            f"{outside} of {count} components are outside the range the "
            "forecast model was trained on, so they used the linear fallback."
        )

    # Median, not mean: latent defects can't be seen at 24 h, so a few of
    # them dominate the mean error even when the forecast is sound.
    if median_actual > 0 and median_error > 0.15 * median_actual:
        warnings.append(
            f"Median forecast error is {median_error:.2f} µA, "
            f"{median_error / median_actual * 100:.0f}% of a typical 168h reading."
        )

    return {
        "mae_ua": round(mae, 3),
        "median_error_ua": round(median_error, 3),
        "max_error_ua": round(float(errors.max()), 3),
        "within_10_percent": round(
            float(np.mean(errors <= 0.10 * np.abs(actual))) * 100, 1
        ),
        "distinct_forecasts": len(rounded),
        "most_common_forecast": common_value,
        "most_common_share": round(common_share, 1),
        "ml_share_percent": round(ml_share, 1),
        "outside_model_range": outside,
        "valid_range": status.get("valid_range"),
        "split_range": status.get("split_range"),
        "training_overlap_percent": overlap,
        "cv_mae_ua": training.get("cv_mae_ua"),
        "cv_median_error_ua": training.get("cv_median_error_ua"),
        "model_type": status.get("model_type"),
        "display_name": status.get("display_name"),
        "warnings": warnings,
        "healthy": not warnings,
    }


def screen_batch(df: pd.DataFrame) -> dict:
    """Screen every component in the batch in one pass."""

    started = perf_counter()

    validate_dataset(df)

    reference = _batch_reference(df)

    predictions = predict_168h_batch(
        df["Current_0h"].astype(float).tolist(),
        df["Current_24h"].astype(float).tolist(),
    )

    results = [
        _analyze_row(component, reference, prediction)
        for component, prediction in zip(
            df.to_dict("records"), predictions
        )
    ]

    count = len(results)
    decisions = Counter(r["decision"] for r in results)
    sources = Counter(r["prediction_source"] for r in results)

    statistics = calculate_batch_statistics(df)
    statistics.update({
        "median_current_168h": round(reference["median"], 4),
        "temperature_min": round(float(df["Temperature"].min()), 2),
        "temperature_max": round(float(df["Temperature"].max()), 2),
        "temperature_mean": round(float(df["Temperature"].mean()), 2),
        "voltage_min": round(float(df["Voltage"].min()), 3),
        "voltage_max": round(float(df["Voltage"].max()), 3),
        "voltage_mean": round(float(df["Voltage"].mean()), 3),
    })

    summary = {
        "component_count": count,
        "decision_counts": {d: decisions.get(d, 0) for d in DECISIONS},
        "yield_percent": round(decisions.get("PASS", 0) / count * 100, 2),
        "mean_anomaly_score": round(
            sum(r["anomaly_score"] for r in results) / count, 2
        ),
        "prediction_sources": dict(sources),
        "review_threshold": REVIEW_THRESHOLD,
        "fail_threshold": FAIL_THRESHOLD,
    }

    return {
        "summary": summary,
        "statistics": statistics,
        "trajectory": _trajectory(df),
        "evaluation": _evaluate_against_labels(results),
        "forecast_check": _forecast_check(df, results),
        "results": results,
        "elapsed_ms": round((perf_counter() - started) * 1000, 1),
    }
