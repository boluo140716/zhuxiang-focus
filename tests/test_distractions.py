"""分心记录 API 测试。"""


def test_add_to_session(client):
    sid = client.post("/api/sessions", json={}).json()["id"]
    r = client.post(f"/api/sessions/{sid}/distractions", json={"source": "manual", "app_name": "抖音", "resolved_reason": "刷手机", "duration_minutes": 5})
    assert r.status_code == 200
    data = r.json()
    assert data["session_id"] == sid
    assert data["source"] == "manual"
    assert data["app_name"] == "抖音"


def test_add_to_missing_session_404(client):
    r = client.post("/api/sessions/99999/distractions", json={})
    assert r.status_code == 404


def test_standalone_distraction(client):
    r = client.post("/api/distractions", json={"source": "phone_pickup", "duration_minutes": 8})
    assert r.status_code == 200
    assert r.json()["session_id"] is None
