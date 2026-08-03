"""会话 API 测试。"""
from datetime import datetime, timedelta

from sqlmodel import Session as DBSession, select

from app.db import engine
from app.models import FocusSession


def _backdate(session_id: int, minutes_ago: int):
    """把会话开始时间改到过去，模拟真实时长。"""
    with DBSession(engine) as db:
        s = db.get(FocusSession, session_id)
        s.started_at = datetime.now() - timedelta(minutes=minutes_ago)
        db.add(s)
        db.commit()


def test_start_and_complete(client):
    r = client.post("/api/sessions", json={"task_name": "写方案", "planned_minutes": 15, "device": "desktop"})
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "running"
    sid = data["id"]

    _backdate(sid, 12)
    r2 = client.patch(f"/api/sessions/{sid}", json={"action": "complete", "completion_score": 80, "flow_score": 4})
    assert r2.status_code == 200
    data2 = r2.json()
    assert data2["status"] == "completed"
    assert data2["actual_minutes"] == 12
    assert data2["completion_score"] == 80
    assert data2["flow_score"] == 4


def test_single_running_constraint(client):
    a = client.post("/api/sessions", json={"task_name": "A"}).json()
    b = client.post("/api/sessions", json={"task_name": "B"}).json()

    with DBSession(engine) as db:
        a_db = db.get(FocusSession, a["id"])
        b_db = db.get(FocusSession, b["id"])
        running = db.exec(select(FocusSession).where(FocusSession.status == "running")).all()
        assert a_db.status == "abandoned"
        assert b_db.status == "running"
        assert len(running) == 1


def test_complete_unknown_returns_404(client):
    r = client.patch("/api/sessions/99999", json={"action": "complete"})
    assert r.status_code == 404


def test_complete_twice_returns_400(client):
    sid = client.post("/api/sessions", json={}).json()["id"]
    assert client.patch(f"/api/sessions/{sid}", json={"action": "complete"}).status_code == 200
    assert client.patch(f"/api/sessions/{sid}", json={"action": "complete"}).status_code == 400


def test_abandon_session(client):
    sid = client.post("/api/sessions", json={"task_name": "放弃测试"}).json()["id"]
    r = client.patch(f"/api/sessions/{sid}", json={"action": "abandon"})
    assert r.json()["status"] == "abandoned"
