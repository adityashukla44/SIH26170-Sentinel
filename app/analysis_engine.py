from typing import Optional


def calculate_drift(current_0h: float, current_24h: float) -> float:
    if current_0h == 0:
        return 0.0

    return (current_24h - current_0h) / current_0h


def calculate_anomaly_score(
    current_0h: float,
    current_24h: float,
    current_96h: Optional[float] = None,
) -> float:

    values = [current_0h, current_24h]

    if current_96h is not None:
        values.append(current_96h)

    if current_0h == 0:
        return 0.0

    maximum_deviation = max(
        abs(value - current_0h) / current_0h
        for value in values
    )

    return round(min(maximum_deviation * 100, 100), 2)


def calculate_deviation_percent(
    current_value: float,
    batch_average: float,
) -> float:

    if batch_average == 0:
        return 0.0

    return round(
        ((current_value - batch_average) / batch_average) * 100,
        2,
    )


def determine_risk(
    anomaly_score: float,
    drift_rate: float,
    predicted_168h: float,
    current_24h: float,
    deviation_percent: float,
) -> tuple[str, str, list[str]]:

    reasons = []

    if anomaly_score >= 70 or deviation_percent >= 200:
        risk_level = "HIGH"
        decision = "FAIL"
    elif anomaly_score >= 30 or deviation_percent >= 50:
        risk_level = "MEDIUM"
        decision = "REVIEW"
    else:
        risk_level = "LOW"
        decision = "PASS"

    if drift_rate > 0.20:
        reasons.append("Strong positive current drift detected")

    if deviation_percent >= 50:
        reasons.append("Component is significantly above the batch average")

    if predicted_168h > current_24h * 2:
        reasons.append("Predicted 168h value shows significant growth")

    if anomaly_score >= 70:
        reasons.append("Highly abnormal behavior detected")

    if not reasons:
        reasons.append("Component behavior is within expected variation")

    return risk_level, decision, reasons
