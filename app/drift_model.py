"""168 h drift model: forecast the burn-in end point from the first 24 hours.

The model learns the growth factor (168 h ÷ 24 h) as a function of the early
drift ((24 h − 0 h) ÷ 0 h). Working in ratios keeps the forecast independent
of a component's absolute current, so a model trained on one batch transfers
to batches that run at a different current level.

This class is pickled into models/drift_model.pkl, so keep it importable at
app.drift_model.
"""

from hashlib import sha1

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, RegressorMixin, clone
from sklearn.linear_model import HuberRegressor


INPUT_COLUMNS = ["Current_0h", "Current_24h"]


def early_drift(current_0h, current_24h) -> np.ndarray:
    c0 = np.asarray(current_0h, dtype=float)
    c24 = np.asarray(current_24h, dtype=float)
    safe = np.where(c0 != 0, c0, 1.0)
    return np.where(c0 != 0, (c24 - c0) / safe, 0.0)


def row_fingerprint(c0: float, c24: float, c96: float, c168: float) -> str:
    """Short fingerprint of one component's readings, used to spot rows the
    model was trained on without storing the training data itself."""
    text = f"{float(c0):.4f},{float(c24):.4f},{float(c96):.4f},{float(c168):.4f}"
    return sha1(text.encode()).hexdigest()[:12]


class GrowthRatioRegressor(BaseEstimator, RegressorMixin):
    """Predicts the 168 h current (µA) from the 0 h and 24 h currents (µA).

    estimator     regressor for growth factor ~ early drift (HuberRegressor
                  by default: robust to the defective parts in the batch)
    range_margin  how far past the training early-drift range, as a share of
                  that range, a forecast is still trusted
    """

    def __init__(self, estimator=None, range_margin=0.25):
        self.estimator = estimator
        self.range_margin = range_margin

    @staticmethod
    def _inputs(X):
        frame = X if isinstance(X, pd.DataFrame) else pd.DataFrame(X, columns=INPUT_COLUMNS)
        c0 = frame["Current_0h"].to_numpy(dtype=float)
        c24 = frame["Current_24h"].to_numpy(dtype=float)
        return c0, c24, early_drift(c0, c24)

    def fit(self, X, y):
        c0, c24, drift = self._inputs(X)
        y = np.asarray(y, dtype=float)
        usable = (c0 > 0) & (c24 > 0)

        self.estimator_ = clone(self.estimator if self.estimator is not None else HuberRegressor())
        self.estimator_.fit(drift[usable].reshape(-1, 1), y[usable] / c24[usable])
        self.early_drift_range_ = [float(drift[usable].min()), float(drift[usable].max())]
        self.n_features_in_ = len(INPUT_COLUMNS)
        return self

    def growth_factor(self, X) -> np.ndarray:
        _, _, drift = self._inputs(X)
        return self.estimator_.predict(drift.reshape(-1, 1))

    def predict(self, X) -> np.ndarray:
        _, c24, drift = self._inputs(X)
        return c24 * self.estimator_.predict(drift.reshape(-1, 1))

    def valid_range(self) -> dict:
        low, high = self.early_drift_range_
        pad = (high - low) * self.range_margin
        return {"early_drift": [low - pad, high + pad]}

    def in_training_range(self, X) -> np.ndarray:
        _, _, drift = self._inputs(X)
        low, high = self.valid_range()["early_drift"]
        return (drift >= low) & (drift <= high)

    def formula(self) -> dict | None:
        coef = getattr(self.estimator_, "coef_", None)
        if coef is None:
            return None
        return {
            "intercept": float(self.estimator_.intercept_),
            "early_drift": float(np.ravel(coef)[0]),
        }
