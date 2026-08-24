from pathlib import Path

import joblib
import numpy as np
import pandas as pd


MODEL_PATH = Path("models/drift_model.pkl")


def fallback_predict(current_0h: float, current_24h: float) -> float:
    """Fallback prediction. Input/output are in µA."""
    hourly_change = (current_24h - current_0h) / 24.0
    prediction = current_0h + (hourly_change * 168.0)
    return round(max(prediction, 0.0), 2)


def is_plausible_prediction(
    prediction_ua: float,
    current_0h: float,
    current_24h: float,
) -> bool:
    """Reject obviously unrealistic ML predictions."""

    if not np.isfinite(prediction_ua):
        return False

    if prediction_ua < 0:
        return False

    reference = max(
        abs(current_0h),
        abs(current_24h),
        1.0,
    )

    if prediction_ua > reference * 100:
        return False

    if reference > 1.0 and prediction_ua < reference * 0.001:
        return False

    return True


def predict_168h(
    current_0h: float,
    current_24h: float,
) -> tuple[float, str]:

    if MODEL_PATH.exists():
        try:
            model = joblib.load(MODEL_PATH)

            # Kunal's NEW model expects µA directly.
            features = pd.DataFrame(
                [[current_0h, current_24h]],
                columns=["Current_0h", "Current_24h"],
            )

            # Model output is also in µA.
            prediction_ua = float(
                model.predict(features)[0]
            )

            if is_plausible_prediction(
                prediction_ua,
                current_0h,
                current_24h,
            ):
                return round(prediction_ua, 2), "ML_MODEL"

            return (
                fallback_predict(current_0h, current_24h),
                "FALLBACK_UNSAFE_MODEL",
            )

        except Exception as exc:
            print(f"ML prediction error: {exc}")
            return (
                fallback_predict(current_0h, current_24h),
                "FALLBACK_MODEL_ERROR",
          )

    return (
        fallback_predict(current_0h, current_24h),
        "FALLBACK_NO_MODEL",
    )
