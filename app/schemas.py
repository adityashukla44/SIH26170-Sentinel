from pydantic import BaseModel, Field


class ComponentData(BaseModel):
    component_id: str
    temperature: float
    voltage: float
    current_0h: float = Field(..., ge=0)
    current_24h: float = Field(..., ge=0)
    current_96h: float | None = Field(default=None, ge=0)
    current_168h: float | None = Field(default=None, ge=0)


class SimulationInput(BaseModel):
    """A hypothetical component, screened against an uploaded batch.

    If component_id matches a component in the batch, that component's
    readings are replaced ("what if C042 had read this instead?").
    """

    component_id: str = Field(default="SIM-001", min_length=1, max_length=64)
    temperature: float
    voltage: float
    current_0h: float = Field(..., ge=0)
    current_24h: float = Field(..., ge=0)
    current_96h: float = Field(..., ge=0)
    current_168h: float = Field(..., ge=0)


class AnalysisResponse(BaseModel):
    component_id: str
    anomaly_score: float
    deviation_percent: float
    drift_rate: float
    predicted_168h: float
    prediction_source: str
    risk_level: str
    decision: str
    reasons: list[str]


class ScoreSignal(BaseModel):
    key: str
    label: str
    weight: float
    input: float
    input_unit: str
    signal: float
    points: float
    max_points: float


class ScoreOverride(BaseModel):
    floor: float
    description: str


class ScoreBreakdown(BaseModel):
    signals: list[ScoreSignal]
    base_score: float
    overrides: list[ScoreOverride]
    escalation: str | None = None
    review_threshold: float
    fail_threshold: float


class BatchComponentAnalysisResponse(BaseModel):
    component_id: str
    batch_size: int
    batch_average_168h: float
    batch_median_168h: float
    batch_std_168h: float
    component_value_168h: float
    deviation_percent: float
    median_deviation_percent: float
    z_score: float
    drift_0_24: float
    drift_24_96: float
    drift_96_168: float
    total_drift: float
    predicted_168h: float
    prediction_source: str
    predicted_deviation_percent: float
    predicted_growth_from_24h: float
    anomaly_score: float
    risk_level: str
    decision: str
    reasons: list[str]
    # Added for the dashboard. Optional, so existing clients are unaffected.
    temperature: float | None = None
    voltage: float | None = None
    current_0h: float | None = None
    current_24h: float | None = None
    current_96h: float | None = None
    current_168h: float | None = None
    label: str | None = None
    score_breakdown: ScoreBreakdown | None = None
