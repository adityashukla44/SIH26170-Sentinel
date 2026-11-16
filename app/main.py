from collections import OrderedDict
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.schemas import (
    ComponentData,
    SimulationInput,
    AnalysisResponse,
    BatchComponentAnalysisResponse,
)

from app.analysis_engine import (
    calculate_anomaly_score,
    calculate_deviation_percent,
    calculate_drift,
    determine_risk,
)

from app.prediction_engine import (
    predict_168h as predict_168h_model,
    model_status,
)

from app.batch_analysis import (
    validate_dataset,
    calculate_batch_statistics,
    analyze_component_against_batch,
    screen_batch,
)


BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
SAMPLE_DATASET = BASE_DIR / "data" / "burn_in_dataset.csv"

API_VERSION = "1.1.0"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_STORED_BATCHES = 16


app = FastAPI(
    title="SIH26170 AI Component Screening API",
    description="AI-driven anomaly detection and burn-in screening backend",
    version=API_VERSION,
)


# CORS for local frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Screened batches are kept in memory so the simulator can compare a
# hypothetical component against them. Oldest batches are dropped first.
_batches: "OrderedDict[str, pd.DataFrame]" = OrderedDict()


def _store_batch(df: pd.DataFrame) -> str:
    batch_id = uuid4().hex[:12]
    _batches[batch_id] = df

    while len(_batches) > MAX_STORED_BATCHES:
        _batches.popitem(last=False)

    return batch_id


def _get_batch(batch_id: str) -> pd.DataFrame:
    if batch_id not in _batches:
        raise HTTPException(
            status_code=404,
            detail=(
                "Batch not found. The server may have restarted; "
                "upload the CSV again."
            ),
        )

    _batches.move_to_end(batch_id)
    return _batches[batch_id]


async def _read_csv_upload(file: UploadFile) -> pd.DataFrame:
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(
            status_code=400,
            detail="Please upload a CSV file.",
        )

    contents = await file.read()

    if not contents.strip():
        raise HTTPException(
            status_code=400,
            detail="The uploaded file is empty.",
        )

    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="The CSV is larger than 10 MB.",
        )

    try:
        return pd.read_csv(BytesIO(contents))
    except (pd.errors.ParserError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Could not read the CSV: {exc}",
        )


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "message": "SIH26170 backend is running",
        "version": API_VERSION,
        "model": model_status(),
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

        # Temporary reference for direct single-component analysis.
        # Batch endpoint uses the real uploaded dataset.
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
async def analyze_batch(file: UploadFile = File(...)):
    try:
        df = await _read_csv_upload(file)

        validate_dataset(df)

        stats = calculate_batch_statistics(df)

        return {
            "status": "success",
            "filename": file.filename,
            "statistics": stats,
        }

    except HTTPException:
        raise

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
        df = await _read_csv_upload(file)

        result = analyze_component_against_batch(
            df,
            component_id,
        )

        return result

    except HTTPException:
        raise

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


@app.post("/batch/screen")
async def screen_uploaded_batch(file: UploadFile = File(...)):
    """Screen every component in the CSV and keep the batch for the simulator."""

    try:
        df = await _read_csv_upload(file)

        result = screen_batch(df)

        return {
            "status": "success",
            "batch_id": _store_batch(df),
            "filename": file.filename,
            "screened_at": datetime.now(timezone.utc).isoformat(),
            "model": model_status(),
            **result,
        }

    except HTTPException:
        raise

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Batch screening failed: {str(exc)}",
        )


@app.post(
    "/batch/{batch_id}/simulate",
    response_model=BatchComponentAnalysisResponse,
)
def simulate_component(batch_id: str, component: SimulationInput):
    """Screen a hypothetical component against a stored batch."""

    df = _get_batch(batch_id)

    row = {
        "Component_ID": component.component_id,
        "Temperature": component.temperature,
        "Voltage": component.voltage,
        "Current_0h": component.current_0h,
        "Current_24h": component.current_24h,
        "Current_96h": component.current_96h,
        "Current_168h": component.current_168h,
    }

    try:
        ids = df["Component_ID"].astype(str)
        others = df[ids != component.component_id]
        candidate = pd.DataFrame([row])

        if "Label" in df.columns:
            existing = df.loc[ids == component.component_id, "Label"]
            candidate["Label"] = (
                existing.iloc[0] if not existing.empty else None
            )

        simulated = pd.concat(
            [others, candidate],
            ignore_index=True,
        )

        return analyze_component_against_batch(
            simulated,
            component.component_id,
        )

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Simulation failed: {str(exc)}",
        )


@app.get("/sample/burn_in_dataset.csv", include_in_schema=False)
def sample_dataset():
    if not SAMPLE_DATASET.exists():
        raise HTTPException(
            status_code=404,
            detail="Sample dataset is missing from data/.",
        )

    return FileResponse(
        SAMPLE_DATASET,
        media_type="text/csv",
        filename="burn_in_dataset.csv",
    )


class DashboardFiles(StaticFiles):
    """Static files that browsers revalidate on every load.

    The dashboard's CSS and JS change between releases without changing names,
    so "no-cache" (revalidate with the ETag, still a cheap 304) keeps a browser
    from pairing new HTML with stale scripts.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Dashboard. Mounted last so every API route above takes priority.
if FRONTEND_DIR.exists():
    app.mount(
        "/",
        DashboardFiles(directory=FRONTEND_DIR, html=True),
        name="frontend",
    )
