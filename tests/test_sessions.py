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
    r2 = client.patch(f"/api/sessions/{sid}", json={"action": "complete", "completion_score": 80, "flow_score": 4, "reliance": "self"})
    assert r2.status_code == 200
    data2 = r2.json()
    assert data2["auto_distracted"] is False  # 本场无黑名单自动检测
    s2 = data2["session"]
    assert s2["status"] == "completed"
    assert s2["actual_minutes"] == 12
    assert s2["completion_score"] == 80
    assert s2["flow_score"] == 4
    assert s2["reliance"] == "self"  # 自评：靠自己


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


def test_current_session(client):
    assert client.get("/api/sessions/current").json() is None
    sid = client.post("/api/sessions", json={"task_name": "进行中"}).json()["id"]
    data = client.get("/api/sessions/current").json()
    assert data["id"] == sid
    assert data["status"] == "running"


def test_actual_minutes_override(client):
    sid = client.post("/api/sessions", json={}).json()["id"]
    r = client.patch(f"/api/sessions/{sid}", json={"action": "complete", "actual_minutes": 7})
    assert r.json()["session"]["actual_minutes"] == 7


def test_abandon_session(client):
    sid = client.post("/api/sessions", json={"task_name": "放弃测试"}).json()["id"]
    r = client.patch(f"/api/sessions/{sid}", json={"action": "abandon"})
    assert r.json()["session"]["status"] == "abandoned"


def test_end_session_saves_reflection(client):
    """结束会话保存复盘文本（reflection），不写则留空。"""
    sid = client.post("/api/sessions", json={"task_name": "写周报"}).json()["id"]
    r = client.patch(f"/api/sessions/{sid}", json={"action": "complete", "reflection": "抖音推送太诱人"})
    assert r.status_code == 200
    assert r.json()["session"]["reflection"] == "抖音推送太诱人"

    sid2 = client.post("/api/sessions", json={}).json()["id"]
    r2 = client.patch(f"/api/sessions/{sid2}", json={"action": "complete"})
    assert r2.json()["session"]["reflection"] is None


def test_start_session_resets_monitor_hit(client):
    """开始新会话应立即重置监控命中状态（防止上一轮残留导致误弹卡）。"""
    import time

    from app.monitor.win_monitor import HIT_STATE, update_hit_state

    update_hit_state(True, "抖音", time.time())
    assert HIT_STATE["hit"] is True
    client.post("/api/sessions", json={"task_name": "重置测试"})
    assert HIT_STATE["hit"] is False and HIT_STATE["total"] == 0


def test_end_session_resets_monitor_hit(client):
    """结束会话应立即重置监控命中状态。"""
    import time

    from app.monitor.win_monitor import HIT_STATE, update_hit_state

    sid = client.post("/api/sessions", json={}).json()["id"]
    update_hit_state(True, "抖音", time.time())
    assert HIT_STATE["hit"] is True
    client.patch(f"/api/sessions/{sid}", json={"action": "abandon"})
    assert HIT_STATE["hit"] is False and HIT_STATE["total"] == 0
