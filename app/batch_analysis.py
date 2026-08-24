import pandas as pd

from app.prediction_engine import predict_168h


REQUIRED_COLUMNS = [
    "Component_ID",
    "Temperature",
    "Voltage",
    "Current_0h",
    "Current_24h",
    "Current_96h",
    "Current_168h",
]


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

    numeric_columns = [
        "Temperature",
        "Voltage",
        "Current_0h",
        "Current_24h",
        "Current_96h",
        "Current_168h",
    ]

    for column in numeric_columns:
        if not pd.api.types.is_numeric_dtype(df[column]):
            raise ValueError(
                f"Column '{column}' must contain numeric values."
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


def analyze_component_against_batch(
    df: pd.DataFrame,
    component_id: str,
) -> dict:

    validate_dataset(df)

    component = get_component(df, component_id)

    values_168h = df["Current_168h"].astype(float)

    batch_average = float(values_168h.mean())
    batch_median = float(values_168h.median())
    batch_std = float(values_168h.std(ddof=0))

    component_value = float(component["Current_168h"])

    # Observed deviation at 168h.
    deviation_percent = (
        ((component_value - batch_average) / batch_average) * 100
        if batch_average != 0
        else 0.0
    )

    median_deviation_percent = (
        ((component_value - batch_median) / batch_median) * 100
        if batch_median != 0
        else 0.0
    )

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
    drift_0_24 = (
        (current_24h - current_0h) / current_0h
        if current_0h != 0
        else 0.0
    )

    drift_24_96 = (
        (current_96h - current_24h) / current_24h
        if current_24h != 0
        else 0.0
    )

    drift_96_168 = (
        (current_168h - current_96h) / current_96h
        if current_96h != 0
        else 0.0
    )

    total_drift = (
        (current_168h - current_0h) / current_0h
        if current_0h != 0
        else 0.0
    )

    # Future prediction.
    predicted_168h, prediction_source = predict_168h(
        current_0h,
        current_24h,
    )

    predicted_deviation_percent = (
        ((predicted_168h - batch_median) / batch_median) * 100
        if batch_median != 0
        else 0.0
    )

    predicted_growth_from_24h = (
        (predicted_168h - current_24h) / current_24h
        if current_24h != 0
        else 0.0
    )

    # -------------------------
    # Dynamic anomaly signals
    # -------------------------

    deviation_signal = min(
        abs(deviation_percent) / 100.0,
        1.0,
    )

    median_signal = min(
        abs(median_deviation_percent) / 150.0,
        1.0,
    )

    z_signal = min(
        abs(z_score) / 3.0,
        1.0,
    )

    drift_signal = min(
        abs(total_drift) / 1.0,
        1.0,
    )

    prediction_signal = min(
        abs(predicted_growth_from_24h) / 1.0,
        1.0,
    )

    # Combined score.
    anomaly_score = (
        0.30 * deviation_signal
        + 0.20 * median_signal
        + 0.15 * z_signal
        + 0.20 * drift_signal
        + 0.15 * prediction_signal
    ) * 100

    # Strong evidence overrides.
    if abs(deviation_percent) >= 100:
        anomaly_score = max(anomaly_score, 80)

    if abs(deviation_percent) >= 200:
        anomaly_score = max(anomaly_score, 90)

    if total_drift >= 1.0:
        anomaly_score = max(anomaly_score, 75)

    if predicted_growth_from_24h >= 1.0:
        anomaly_score = max(anomaly_score, 75)

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

    if anomaly_score >= 70:
        risk_level = "HIGH"
        decision = "FAIL"
    elif anomaly_score >= 35:
        risk_level = "MEDIUM"
        decision = "REVIEW"
    else:
        risk_level = "LOW"
        decision = "PASS"

    # Future-risk escalation.
    if predicted_growth_from_24h >= 1.0:
        risk_level = "HIGH"
        decision = "FAIL"
    elif predicted_growth_from_24h >= 0.50 and risk_level == "LOW":
        risk_level = "MEDIUM"
        decision = "REVIEW"

    return {
        "component_id": str(component_id),
        "batch_size": int(len(df)),
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
    }
