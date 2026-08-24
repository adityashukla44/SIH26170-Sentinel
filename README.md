# SIH26170 — AI Component Screening Backend

## Purpose
AI-driven anomaly detection and burn-in screening for spacecraft electronic components.

## Run
source .venv/bin/activate
uvicorn app.main:app --reload

## APIs
GET /health
POST /analyze
POST /batch/analyze
POST /batch/analyze-component

## Main Workflow
CSV → Validation → Batch Analysis → Anomaly Detection → Drift Analysis → 168h Prediction → Risk → Explanation → PASS/REVIEW/FAIL

## Units
Backend prototype current values are in µA.

## Main Endpoint
POST /batch/analyze-component

Input:
- CSV file
- component_id

Output:
- anomaly score
- deviation
- drift
- predicted 168h
- risk level
- decision
- explanation
