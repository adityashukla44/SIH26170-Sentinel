from pydantic import BaseModel, Field


class ComponentData(BaseModel):
    component_id: str
    temperature: float
    voltage: float
    current_0h: float = Field(..., ge=0)
    current_24h: float = Field(..., ge=0)
    current_96h: float | None = Field(default=None, ge=0)
    current_168h: float | None = Field(default=None, ge=0)


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
