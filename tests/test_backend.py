from io import BytesIO

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health():
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_analyze_healthy_component():
    payload = {
        "component_id": "C001",
        "temperature": 125,
        "voltage": 5.0,
        "current_0h": 10.0,
        "current_24h": 10.2,
        "current_96h": 10.3,
        "current_168h": 10.4,
    }

    response = client.post("/analyze", json=payload)

    assert response.status_code == 200

    result = response.json()

    assert "anomaly_score" in result
    assert "predicted_168h" in result
    assert "risk_level" in result
    assert "decision" in result


def test_analyze_latent_defect():
    payload = {
        "component_id": "C101",
        "temperature": 125,
        "voltage": 5.0,
        "current_0h": 10.0,
        "current_24h": 11.0,
        "current_96h": 18.0,
        "current_168h": 32.0,
    }

    response = client.post("/analyze", json=payload)

    assert response.status_code == 200

    result = response.json()

    assert result["anomaly_score"] >= 0
    assert result["predicted_168h"] >= 0
    assert result["decision"] in ["PASS", "REVIEW", "FAIL"]


def test_missing_component():
    csv_content = """Component_ID,Temperature,Voltage,Current_0h,Current_24h,Current_96h,Current_168h
C001,125,5.0,10,10.2,10.3,10.4
"""

    response = client.post(
        "/batch/analyze-component",
        files={
            "file": (
                "test.csv",
                BytesIO(csv_content.encode()),
                "text/csv",
            )
        },
        data={"component_id": "C999"},
    )

    assert response.status_code == 400
