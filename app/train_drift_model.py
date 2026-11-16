"""Train the 168 h drift model and write models/drift_model.pkl + .json.

Run from the project folder:

    python -m app.train_drift_model            # train and save
    python -m app.train_drift_model --compare  # also compare other models

Every metric is cross-validated: each component is forecast by a model that
never saw it, then run through the real screening rules, so the reported
false-alarm and detection numbers are honest.
"""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.base import clone
from sklearn.ensemble import (
    GradientBoostingRegressor,
    HistGradientBoostingRegressor,
    RandomForestRegressor,
)
from sklearn.linear_model import HuberRegressor
from sklearn.model_selection import KFold, cross_val_predict

from app.batch_analysis import (
    LABEL_COLUMN,
    _analyze_row,
    _batch_reference,
    _evaluate_against_labels,
    validate_dataset,
)
from app.drift_model import INPUT_COLUMNS, GrowthRatioRegressor, row_fingerprint
from app.prediction_engine import fallback_predict, is_plausible_prediction


BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DATA = BASE_DIR / "data" / "burn_in_dataset.csv"
DEFAULT_OUTPUT = BASE_DIR / "models" / "drift_model.pkl"
TARGET = "Current_168h"
SEED = 42


def chosen_model() -> GrowthRatioRegressor:
    return GrowthRatioRegressor(HuberRegressor())


def candidates() -> dict:
    return {
        "Huber growth model (chosen)": chosen_model(),
        "Monotonic HistGB growth model": GrowthRatioRegressor(
            HistGradientBoostingRegressor(
                loss="absolute_error",
                monotonic_cst=[1],
                max_depth=3,
                min_samples_leaf=10,
                learning_rate=0.05,
                max_iter=300,
                random_state=SEED,
            )
        ),
        "RandomForest on raw currents": RandomForestRegressor(
            n_estimators=300, random_state=SEED
        ),
        "GradientBoosting on raw currents": GradientBoostingRegressor(
            loss="absolute_error",
            n_estimators=200,
            max_depth=2,
            learning_rate=0.05,
            random_state=SEED,
        ),
    }


def out_of_fold(model, X: pd.DataFrame, y: pd.Series, folds: int) -> np.ndarray:
    cv = KFold(n_splits=folds, shuffle=True, random_state=SEED)
    return cross_val_predict(clone(model), X, y, cv=cv)


def decision_check(df: pd.DataFrame, predictions: np.ndarray) -> dict | None:
    """Screen every component with the given forecasts, as the API would."""

    reference = _batch_reference(df)
    results = []

    for component, prediction in zip(df.to_dict("records"), predictions):
        c0 = float(component["Current_0h"])
        c24 = float(component["Current_24h"])
        value = float(prediction)

        if is_plausible_prediction(value, c0, c24):
            forecast = (round(value, 2), "ML_MODEL")
        else:
            forecast = (fallback_predict(c0, c24), "FALLBACK_UNSAFE_MODEL")

        results.append(_analyze_row(component, reference, forecast))

    evaluation = _evaluate_against_labels(results)

    if evaluation is None:
        return None

    return {
        key: evaluation[key]
        for key in [
            "defect_count",
            "defects_flagged",
            "healthy_count",
            "healthy_flagged",
            "matrix",
        ]
    }


def errors(y: pd.Series, predictions: np.ndarray) -> np.ndarray:
    return np.abs(np.asarray(predictions, dtype=float) - y.to_numpy(dtype=float))


def compare(df: pd.DataFrame, X: pd.DataFrame, y: pd.Series, folds: int) -> None:
    print(f"\nCandidates, {folds}-fold cross-validated:")
    print(f"  {'model':34s} {'MAE µA':>7s} {'median':>7s} {'defects caught':>15s} {'healthy flagged':>16s}")

    for name, model in candidates().items():
        oof = out_of_fold(model, X, y, folds)
        err = errors(y, oof)
        check = decision_check(df, oof)
        caught = f"{check['defects_flagged']}/{check['defect_count']}" if check else "n/a"
        flagged = f"{check['healthy_flagged']}/{check['healthy_count']}" if check else "n/a"
        print(f"  {name:34s} {err.mean():7.2f} {np.median(err):7.2f} {caught:>15s} {flagged:>16s}")


def train(data: Path, output: Path, folds: int, show_comparison: bool) -> dict:
    df = pd.read_csv(data)
    validate_dataset(df)

    X = df[INPUT_COLUMNS].astype(float)
    y = df[TARGET].astype(float)

    model = chosen_model()
    oof = out_of_fold(model, X, y, folds)
    cv_err = errors(y, oof)

    model.fit(X, y)
    in_sample_err = errors(y, model.predict(X))

    by_label = None
    if LABEL_COLUMN in df.columns:
        labels = df[LABEL_COLUMN].astype(str)
        by_label = {
            label: round(float(cv_err[(labels == label).to_numpy()].mean()), 3)
            for label in sorted(labels.unique())
        }

    output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, output)

    try:
        dataset = str(data.resolve().relative_to(BASE_DIR))
    except ValueError:
        dataset = str(data)

    formula = model.formula()
    metadata = {
        "name": "Drift growth model",
        "model": "GrowthRatioRegressor(HuberRegressor)",
        "description": "168 h = 24 h × (intercept + slope × early drift), early drift = (24 h − 0 h) ÷ 0 h",
        "formula": {k: round(v, 6) for k, v in formula.items()} if formula else None,
        "inputs": INPUT_COLUMNS,
        "target": TARGET,
        "unit": "µA",
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": dataset,
        "rows": int(len(df)),
        "folds": folds,
        "cv_mae_ua": round(float(cv_err.mean()), 3),
        "cv_median_error_ua": round(float(np.median(cv_err)), 3),
        "cv_within_10_percent": round(float(np.mean(cv_err <= 0.10 * np.abs(y.to_numpy()))) * 100, 1),
        "cv_mae_by_label": by_label,
        "in_sample_mae_ua": round(float(in_sample_err.mean()), 3),
        "cv_decision_check": decision_check(df, oof),
        "early_drift_range": [round(v, 6) for v in model.early_drift_range_],
        "valid_range": {k: [round(v, 6) for v in r] for k, r in model.valid_range().items()},
        "range_margin": model.range_margin,
        "sklearn_version": sklearn.__version__,
        "model_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "row_fingerprints": [
            row_fingerprint(r.Current_0h, r.Current_24h, r.Current_96h, r.Current_168h)
            for r in df.itertuples(index=False)
        ],
    }

    sidecar = output.with_suffix(".json")
    sidecar.write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Trained {metadata['model']} on {metadata['rows']} components from {dataset}")
    if formula:
        print(
            f"  168 h = 24 h × ({formula['intercept']:.4f} + {formula['early_drift']:.4f} × early drift)"
        )
    print(f"  {folds}-fold CV MAE {metadata['cv_mae_ua']} µA, median error {metadata['cv_median_error_ua']} µA, in-sample MAE {metadata['in_sample_mae_ua']} µA")
    if by_label:
        print("  CV MAE by label: " + ", ".join(f"{k} {v}" for k, v in by_label.items()))
    check = metadata["cv_decision_check"]
    if check:
        print(
            f"  Screening with cross-validated forecasts: {check['defects_flagged']}/{check['defect_count']} defects flagged, "
            f"{check['healthy_flagged']}/{check['healthy_count']} healthy flagged"
        )
    print(f"  Trusted early-drift range {metadata['valid_range']['early_drift']}")
    print(f"Saved {output} and {sidecar}")

    if show_comparison:
        compare(df, X, y, folds)

    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the 168 h drift model.")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="burn-in CSV to train on")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="where to write the .pkl (the .json goes next to it)")
    parser.add_argument("--folds", type=int, default=5, help="cross-validation folds")
    parser.add_argument("--compare", action="store_true", help="also compare alternative models")
    args = parser.parse_args()

    train(args.data, args.output, args.folds, args.compare)


if __name__ == "__main__":
    main()
