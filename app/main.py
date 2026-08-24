from io import BytesIO

import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile, File, Form

from app.schemas import (
    ComponentData,
    AnalysisResponse,
    BatchComponentAnalysisResponse,
)

from app.prediction_engine import predict_168h as predict_168h_model

from app.analysis_engine import (
    calculate_anomaly_score,
    calculate_deviation_percent,
    calculate_drift,
    predict_168h,
    determine_risk,
)

from app.batch_analysis import (
    validate_dataset,
    calculate_batch_statistics,
    analyze_component_against_batch,
)


app = FastAPI(
    title="SIH26170 AI Component Screening API",
    description="AI-driven anomaly detection and burn-in screening backend",
    version="1.0.0",
)


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "message": "SIH26170 backend is running",
    }


@app.post("/analyze", response_model=AnalysisResponse)
def analyze_component(component: ComponentData):

    try:
        anomaly_score = calculate_anomaly_score(
            component.current_0h,
            component.current_24h,
            component.current_96h,
        )

        drift_rate = calculate_drift(
            component.current_0h,
            component.current_24h,
        )

        predicted_168h, prediction_source = predict_168h_model(
            component.current_0h,
            component.current_24h,
        )

        batch_average = 10.0

        latest_value = (
            component.current_96h
            if component.current_96h is not None
            else component.current_24h
        )

        deviation_percent = calculate_deviation_percent(
            latest_value,
            batch_average,
        )

        risk_level, decision, reasons = determine_risk(
            anomaly_score,
            drift_rate,
            predicted_168h,
            component.current_24h,
            deviation_percent,
        )

        return AnalysisResponse(
            component_id=component.component_id,
            anomaly_score=anomaly_score,
            deviation_percent=deviation_percent,
            drift_rate=round(drift_rate, 4),
            predicted_168h=round(predicted_168h, 2),
            prediction_source=prediction_source,
            risk_level=risk_level,
            decision=decision,
            reasons=reasons,
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Analysis failed: {str(exc)}",
        )


@app.post("/batch/analyze")
async def analyze_batch(
    file: UploadFile = File(...)
):
    try:
        if not file.filename.lower().endswith(".csv"):
            raise HTTPException(
                status_code=400,
                detail="Please upload a CSV file.",
            )

        contents = await file.read()
        df = pd.read_csv(BytesIO(contents))

        validate_dataset(df)

        stats = calculate_batch_statistics(df)

        return {
            "status": "success",
            "filename": file.filename,
            "statistics": stats,
        }

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Batch analysis failed: {str(exc)}",
        )


@app.post(
    "/batch/analyze-component",
    response_model=BatchComponentAnalysisResponse,
)
async def analyze_batch_component(
    file: UploadFile = File(...),
    component_id: str = Form(...),
):
    try:
        if not file.filename.lower().endswith(".csv"):
            raise HTTPException(
                status_code=400,
                detail="Please upload a CSV file.",
            )

        contents = await file.read()
        df = pd.read_csv(BytesIO(contents))

        result = analyze_component_against_batch(
            df,
            component_id,
        )

        return result

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Component analysis failed: {str(exc)}",
        )
