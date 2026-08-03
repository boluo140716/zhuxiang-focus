"""统计 API 测试。"""
from datetime import date, datetime, time, timedelta

from sqlmodel import Session as DBSession

from app.db import engine
from app.models import Distraction, FocusSession


def _seed_today():
    """种一条今天完成的达标会话 + 一条分心（固定到今天，避免午夜边界）。"""
    today10 = datetime.combine(date.today(), time(10, 0))
    today20 = datetime.combine(date.today(), time(20, 0))
    with DBSession(engine) as db:
        s = FocusSession(task_name="种子", planned_minutes=15, status="running", started_at=today10)
        db.add(s)
        db.commit()
        db.refresh(s)
        s.status = "completed"
        s.ended_at = today10 + timedelta(minutes=30)
        s.actual_minutes = 30
        s.completion_score = 70
        s.flow_score = 4
        db.add(s)
        db.add(Distraction(source="auto_detect", app_name="抖音", duration_minutes=10, occurred_at=today20))
        db.commit()


def test_daily(client):
    _seed_today()
    data = client.get("/api/stats/daily").json()
    assert data["focus_minutes"] == 30
    assert data["distractions"] == 1
    assert data["distraction_minutes"] == 10
    assert data["qualified"] is True
    assert any(h["hour"] == 20 for h in data["distraction_by_hour"])


def test_weekly(client):
    _seed_today()
    data = client.get("/api/stats/weekly").json()
    assert len(data["days"]) == 7
    assert data["streak"] >= 1
    assert data["completion_rate"] >= 1 / 7


def test_insights(client):
    _seed_today()
    data = client.get("/api/stats/insights").json()
    assert data["total_distractions"] >= 1
    assert data["worst_hours"][0]["hour"] == 20
    assert data["auto_detected"] >= 1


def test_next_target(client):
    _seed_today()
    data = client.get("/api/stats/next_target").json()
    assert data["current_target"] == 15
    # 一周仅 1 个达标日，完成率 1/7 < 50% → 建议降为 10
    assert data["suggested_target"] == 10
