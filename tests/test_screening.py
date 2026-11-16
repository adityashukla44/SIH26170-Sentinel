from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)

DATASET = Path(__file__).resolve().parent.parent / "data" / "burn_in_dataset.csv"

SMALL_CSV = """Component_ID,Temperature,Voltage,Current_0h,Current_24h,Current_96h,Current_168h
C001,125,5.0,10.1,10.3,10.4,10.5
C002,125,5.0,9.8,10.0,10.2,10.4
C003,125,5.0,10.2,10.5,11.0,11.2
C004,125,5.0,10.0,11.0,18.0,32.0
"""


def upload(path, content, filename="batch.csv", data=None):
    return client.post(
        path,
        files={"file": (filename, BytesIO(content), "text/csv")},
        data=data or {},
    )


def screen_dataset():
    response = upload("/batch/screen", DATASET.read_bytes(), "burn_in_dataset.csv")
    assert response.status_code == 200
    return response.json()


def test_health_reports_model():
    body = client.get("/health").json()
    model = body["model"]

    assert body["status"] == "ok"
    assert model["source"] == "ML_MODEL"
    assert model["display_name"] == "Drift growth model"
    assert model["valid_range"]["early_drift"][0] < 0 < model["valid_range"]["early_drift"][1]

    training = model["training"]
    assert training["cv_mae_ua"] > 0
    assert training["rows"] == 200
    assert "row_fingerprints" not in training


def test_sample_batch_has_few_false_alarms():
    body = screen_dataset()
    evaluation = body["evaluation"]
    forecast = body["forecast_check"]

    assert evaluation["defects_flagged"] == evaluation["defect_count"] == 40
    assert evaluation["healthy_flagged"] <= 5
    assert forecast["healthy"], forecast["warnings"]
    assert forecast["ml_share_percent"] == 100
    assert forecast["training_overlap_percent"] == 100
    assert forecast["distinct_forecasts"] > 100


def test_out_of_range_forecast_uses_fallback():
    from app.prediction_engine import fallback_predict, predict_168h_batch

    # 0h 10 → 24h 40 µA is a 300% early drift, far past anything trained on.
    extreme, normal = predict_168h_batch([10.0, 12.0], [40.0, 12.4])

    assert extreme == (fallback_predict(10.0, 40.0), "FALLBACK_OUT_OF_RANGE")
    assert normal[1] == "ML_MODEL"


def test_training_script_writes_model_and_metadata(tmp_path):
    import json

    import joblib

    from app.train_drift_model import train

    output = tmp_path / "drift_model.pkl"
    metadata = train(DATASET, output, folds=5, show_comparison=False)

    saved = json.loads(output.with_suffix(".json").read_text(encoding="utf-8"))
    model = joblib.load(output)

    assert saved["cv_mae_ua"] == metadata["cv_mae_ua"] > 0
    assert saved["cv_decision_check"]["healthy_flagged"] <= 5
    assert len(saved["row_fingerprints"]) == 200
    assert type(model).__module__ == "app.drift_model"
    assert model.predict(
        __import__("pandas").DataFrame([[12.0, 12.4]], columns=["Current_0h", "Current_24h"])
    )[0] > 0


def test_screen_whole_batch():
    body = screen_dataset()
    summary = body["summary"]

    assert body["batch_id"]
    assert summary["component_count"] == 200
    assert len(body["results"]) == 200
    assert sum(summary["decision_counts"].values()) == 200
    assert body["trajectory"]["hours"] == [0, 24, 96, 168]
    assert body["forecast_check"]["mae_ua"] >= 0
    assert body["evaluation"]["defect_count"] == 40

    first = body["results"][0]
    assert first["decision"] in {"PASS", "REVIEW", "FAIL"}
    assert len(first["score_breakdown"]["signals"]) == 5
    assert first["label"] is not None


def test_screen_matches_single_component_endpoint():
    body = screen_dataset()
    by_id = {r["component_id"]: r for r in body["results"]}

    for component_id in ["C001", "C150", "C190"]:
        single = upload(
            "/batch/analyze-component",
            DATASET.read_bytes(),
            data={"component_id": component_id},
        ).json()

        for key in ["anomaly_score", "decision", "risk_level", "predicted_168h", "reasons"]:
            assert single[key] == by_id[component_id][key]


def test_screen_without_labels_has_no_evaluation():
    body = upload("/batch/screen", SMALL_CSV.encode()).json()

    assert body["evaluation"] is None
    assert body["summary"]["component_count"] == 4


def test_simulate_new_and_existing_component():
    batch_id = screen_dataset()["batch_id"]

    payload = {
        "component_id": "SIM-001",
        "temperature": 30,
        "voltage": 5.0,
        "current_0h": 12.0,
        "current_24h": 13.2,
        "current_96h": 21.6,
        "current_168h": 38.4,
    }

    added = client.post(f"/batch/{batch_id}/simulate", json=payload)
    assert added.status_code == 200
    assert added.json()["batch_size"] == 201
    assert added.json()["decision"] in {"REVIEW", "FAIL"}

    replaced = client.post(
        f"/batch/{batch_id}/simulate",
        json={**payload, "component_id": "C001"},
    )
    assert replaced.status_code == 200
    assert replaced.json()["batch_size"] == 200
    assert replaced.json()["label"] == "Healthy"


def test_simulate_unknown_batch_is_404():
    response = client.post(
        "/batch/does-not-exist/simulate",
        json={
            "temperature": 30,
            "voltage": 5.0,
            "current_0h": 1,
            "current_24h": 1,
            "current_96h": 1,
            "current_168h": 1,
        },
    )

    assert response.status_code == 404


def test_non_csv_upload_is_400_not_500():
    for path in ["/batch/analyze", "/batch/analyze-component", "/batch/screen"]:
        response = upload(
            path,
            b"not a csv",
            filename="notes.txt",
            data={"component_id": "C001"},
        )
        assert response.status_code == 400, path


def test_missing_values_are_rejected():
    csv = SMALL_CSV.replace("10.5\n", "\n", 1)

    response = upload("/batch/screen", csv.encode())

    assert response.status_code == 400
    assert "Missing values" in response.json()["detail"]


def test_dashboard_and_sample_are_served():
    page = client.get("/")
    assert page.status_code == 200
    assert "Sentinel" in page.text

    sample = client.get("/sample/burn_in_dataset.csv")
    assert sample.status_code == 200
    assert sample.text.startswith("Component_ID")
