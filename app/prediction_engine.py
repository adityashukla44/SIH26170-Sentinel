import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Sequence

import joblib
import numpy as np
import pandas as pd


BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = BASE_DIR / "models" / "drift_model.pkl"
# Written next to the model by `python -m app.train_drift_model`.
METADATA_PATH = MODEL_PATH.with_suffix(".json")
FEATURE_COLUMNS = ["Current_0h", "Current_24h"]

# For tree models without their own range check: how far past the split
# range (as a share of its width) a forecast is still trusted.
SPLIT_RANGE_MARGIN = 0.10


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


@lru_cache(maxsize=1)
def _load_model():
    """Load the drift model once per process (it used to load on every call).

    Returns (model, fallback_source). fallback_source is None when the
    model loaded, otherwise the prediction_source to report.
    """
    if not MODEL_PATH.exists():
        return None, "FALLBACK_NO_MODEL"

    try:
        return joblib.load(MODEL_PATH), None
    except Exception as exc:
        print(f"ML model load error: {exc}")
        return None, "FALLBACK_MODEL_ERROR"


@lru_cache(maxsize=1)
def _split_range() -> dict | None:
    """Input range a tree-based model actually responds to.

    Outside the lowest and highest split threshold of a feature, changing
    that feature can no longer change the prediction.
    """
    model, _ = _load_model()
    trees = getattr(model, "estimators_", None)

    if trees is None and hasattr(model, "tree_"):
        trees = [model]

    if trees is None:
        return None

    try:
        features = []
        thresholds = []

        for tree in np.ravel(trees):
            features.append(tree.tree_.feature)
            thresholds.append(tree.tree_.threshold)

        features = np.concatenate(features)
        thresholds = np.concatenate(thresholds)

        ranges = {}

        for index, name in enumerate(FEATURE_COLUMNS):
            values = thresholds[features == index]
            if values.size:
                ranges[name] = [
                    round(float(values.min()), 4),
                    round(float(values.max()), 4),
                ]

        return ranges or None
    except Exception:
        return None


@lru_cache(maxsize=1)
def _load_metadata() -> dict | None:
    """Training facts written next to the model, if they belong to it.

    The JSON records the SHA-256 of the .pkl it was written with, so a model
    dropped in without fresh metadata is never described by stale numbers.
    """
    if not METADATA_PATH.exists() or not MODEL_PATH.exists():
        return None

    try:
        metadata = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"Model metadata load error: {exc}")
        return None

    expected = metadata.get("model_sha256")
    if expected:
        actual = hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest()
        if actual != expected:
            print("Model metadata ignored: it was written for a different drift_model.pkl")
            return None

    return metadata


@lru_cache(maxsize=1)
def _valid_range() -> dict | None:
    """Inputs the forecast is trusted for, as {feature: [low, high]}."""
    model, _ = _load_model()

    if model is None:
        return None

    own_range = getattr(model, "valid_range", None)
    if callable(own_range):
        try:
            return {
                name: [round(float(low), 4), round(float(high), 4)]
                for name, (low, high) in own_range().items()
            }
        except Exception:
            return None

    split = _split_range()
    if not split:
        return None

    padded = {}
    for name, (low, high) in split.items():
        pad = (high - low) * SPLIT_RANGE_MARGIN
        padded[name] = [round(low - pad, 4), round(high + pad, 4)]

    return padded


def _in_range(model, features: pd.DataFrame) -> np.ndarray:
    """True for rows inside the range the model was trained on."""
    everything = np.ones(len(features), dtype=bool)

    own_check = getattr(model, "in_training_range", None)
    if callable(own_check):
        try:
            return np.asarray(own_check(features), dtype=bool)
        except Exception:
            return everything

    ranges = _valid_range()
    if not ranges:
        return everything

    mask = everything.copy()
    for name, (low, high) in ranges.items():
        if name in features.columns:
            values = features[name].to_numpy(dtype=float)
            mask &= (values >= low) & (values <= high)

    return mask


def training_fingerprints() -> frozenset:
    metadata = _load_metadata() or {}
    return frozenset(metadata.get("row_fingerprints") or [])


def reload_model() -> None:
    """Forget the cached model, e.g. after a retrained .pkl is dropped in."""
    _load_model.cache_clear()
    _split_range.cache_clear()
    _load_metadata.cache_clear()
    _valid_range.cache_clear()


def model_status() -> dict:
    model, fallback_source = _load_model()
    metadata = _load_metadata() if model is not None else None
    model_type = type(model).__name__ if model is not None else None

    training = None
    if metadata:
        training = {
            key: value
            for key, value in metadata.items()
            if key != "row_fingerprints"
        }

    return {
        "loaded": model is not None,
        "source": "ML_MODEL" if model is not None else fallback_source,
        "model_type": model_type,
        "display_name": (metadata or {}).get("name") or model_type,
        "features": FEATURE_COLUMNS,
        "unit": "µA",
        "split_range": _split_range(),
        "valid_range": _valid_range(),
        "training": training,
    }


def predict_168h_batch(
    currents_0h: Sequence[float],
    currents_24h: Sequence[float],
) -> list[tuple[float, str]]:
    """Predict the 168h current for many components in one model call."""

    pairs = [
        (float(c0), float(c24))
        for c0, c24 in zip(currents_0h, currents_24h)
    ]

    model, fallback_source = _load_model()

    if model is None:
        return [
            (fallback_predict(c0, c24), fallback_source)
            for c0, c24 in pairs
        ]

    try:
        # The model expects µA directly and returns µA.
        features = pd.DataFrame(pairs, columns=FEATURE_COLUMNS)
        predictions = model.predict(features)
    except Exception as exc:
        print(f"ML prediction error: {exc}")
        return [
            (fallback_predict(c0, c24), "FALLBACK_MODEL_ERROR")
            for c0, c24 in pairs
        ]

    # A model only knows the inputs it was trained on; outside them (the old
    # RandomForest gave one flat answer) the linear fallback is safer.
    in_range = _in_range(model, features)

    results = []

    for prediction, (c0, c24), trusted in zip(predictions, pairs, in_range):
        prediction_ua = float(prediction)

        if not trusted:
            results.append(
                (fallback_predict(c0, c24), "FALLBACK_OUT_OF_RANGE")
            )
        elif is_plausible_prediction(prediction_ua, c0, c24):
            results.append((round(prediction_ua, 2), "ML_MODEL"))
        else:
            results.append(
                (fallback_predict(c0, c24), "FALLBACK_UNSAFE_MODEL")
            )

    return results


def predict_168h(
    current_0h: float,
    current_24h: float,
) -> tuple[float, str]:
    return predict_168h_batch([current_0h], [current_24h])[0]
