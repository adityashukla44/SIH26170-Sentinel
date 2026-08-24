from pathlib import Path

import joblib
import numpy as np


MODEL_PATH = Path("models/drift_model.pkl")


def fallback_predict(current_0h: float, current_24h: float) -> float:
    """
    Temporary fallback until Kunal's trained model is available.
    Uses linear extrapolation from 0h and 24h.
    """
    hourly_change = (current_24h - current_0h) / 24.0
    prediction = current_0h + (hourly_change * 168.0)

    return round(max(prediction, 0.0), 2)


def predict_168h(current_0h: float, current_24h: float) -> tuple[float, str]:
    """
    Use Kunal's trained model when available.
    Otherwise use the fallback predictor.
    """

    if MODEL_PATH.exists():
        try:
            model = joblib.load(MODEL_PATH)

            features = np.array(
                [[current_0h, current_24h]],
                dtype=float,
            )

            prediction = float(model.predict(features)[0])

            return round(max(prediction, 0.0), 2), "ML_MODEL"

        except Exception:
            # If the saved model is incompatible or fails,
            # safely fall back instead of breaking the API.
            pass

    return fallback_predict(
        current_0h,
        current_24h,
    ), "FALLBACK"
