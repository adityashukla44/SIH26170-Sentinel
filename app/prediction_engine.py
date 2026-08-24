from pathlib import Path

import joblib
import numpy as np


MODEL_PATH = Path("models/drift_model.pkl")

# Backend uses µA.
# Kunal's model uses mA.
UA_TO_MA = 1.0 / 1000.0
MA_TO_UA = 1000.0


def fallback_predict(current_0h: float, current_24h: float) -> float:
    """
    Simple fallback prediction.
    Input/output: µA.
    """
    hourly_change = (current_24h - current_0h) / 24.0
    prediction = current_0h + (hourly_change * 168.0)

    return round(max(prediction, 0.0), 2)


def is_plausible_prediction(
    prediction_ua: float,
    current_0h: float,
    current_24h: float,
) -> bool:
    """
    Safety check for obviously incompatible ML predictions.

    Reject:
    - non-finite values
    - negative values
    - predictions wildly outside the observed scale
    """
    if not np.isfinite(prediction_ua):
        return False

    if prediction_ua < 0:
        return False

    reference = max(abs(current_0h), abs(current_24h), 1.0)

    # For a prototy, reject predictions >100x the largest
    # observed early measurement.
    if prediction_ua > reference * 100:
        return False

    # Also reject extreme collapse to almost zero when inputs
    # are clearly non-zero.
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

            # Backend µA -> model mA
            current_0h_ma = current_0h * UA_TO_MA
            current_24h_ma = current_24h * UA_TO_MA

            features = np.array(
                [[current_0h_ma, current_24h_ma]],
                dtype=float,
            )

            prediction_ma = float(model.predict(features)[0])

            # Model mA -> backend µA
            prediction_ua = prediction_ma * MA_TO_UA

            if is_plausible_prediction(
                prediction_ua,
                current_,
                current_24h,
            ):
                return round(prediction_ua, 2), "ML_MODEL"

            return (
                fallback_predict(current_0h, current_24h),
                "FALLBACK_UNSAFE_MODEL",
            )

        except Exception:
            return (
                fallback_predict(current_0h, current_24h),
                "FALLBACK_MODEL_ERROR",
            )

    return (
        fallback_predict(current_0h, current_24h),
        "FALLBACK_NO_MODEL",
    )
