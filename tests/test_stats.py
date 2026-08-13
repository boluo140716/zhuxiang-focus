"""统计 API 测试。"""
from datetime import date, datetime, time, timedelta

from sqlmodel import Session as DBSession

from app.db import engine
from app.models import Distraction, FocusSession
from tests.conftest import default_user_id


def _seed_today():
    """种一条今天完成的达标会话 + 一条分心（固定到今天，避免午夜边界）。"""
    today10 = datetime.combine(date.today(), time(10, 0))
    today20 = datetime.combine(date.today(), time(20, 0))
    with DBSession(engine) as db:
        s = FocusSession(task_name="种子", planned_minutes=15, status="running", started_at=today10, user_id=default_user_id())
        db.add(s)
        db.add(Distraction(source="auto_detect", app_name="抖音", duration_minutes=10, occurred_at=today20, user_id=default_user_id()))
        db.commit()
        db.refresh(s)
        s.status = "completed"
        s.ended_at = today10 + timedelta(minutes=30)
        s.actual_minutes = 30
        s.completion_score = 70
        s.flow_score = 4
        s.reliance = "self"
        db.add(s)
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
    assert len(data["prev_week_days"]) == 7  # 上周 7 天（用于周对比图）
    assert data["streak"] >= 1
    assert data["completion_rate"] >= 1 / 7
    assert "rate_28d" in data["graduation"]
    assert "self_rate_28d" in data["graduation"]
    assert "eligible" in data["graduation"]


def test_weekly_reliance(client):
    """本周完成场次中「靠自己」的比例。"""
    _seed_today()
    data = client.get("/api/stats/weekly").json()
    assert data["self_sessions"] == 1
    assert data["product_sessions"] == 0
    assert data["self_rate"] == 1.0


def test_reflections(client):
    """复盘回看：返回最近 7 天摘要 + 写了复盘的已完成/放弃会话，按时间倒序。"""
    now = datetime.now()
    with DBSession(engine) as db:
        db.add_all([
            FocusSession(task_name="写周报", status="completed",
                         started_at=now - timedelta(days=1), ended_at=now - timedelta(days=1) + timedelta(minutes=30),
                         reflection="被打断", user_id=default_user_id()),
            FocusSession(task_name="读书", status="abandoned",
                         started_at=now - timedelta(hours=2), ended_at=now - timedelta(hours=2) + timedelta(minutes=10),
                         reflection="静不下心", user_id=default_user_id()),
            FocusSession(task_name="无复盘", status="completed",
                         started_at=now - timedelta(hours=1), ended_at=now, user_id=default_user_id()),
        ])
        db.commit()
    data = client.get("/api/stats/reflections").json()
    assert data["summary"]["last7d_count"] == 2
    assert data["summary"]["top_reason"]["text"] in ("被打断", "静不下心")  # 固定快捷词命中（并列时取先出现者）
    items = data["items"]
    assert len(items) == 2
    assert items[0]["task_name"] == "读书"  # 更近的排前面
    assert items[0]["status"] == "abandoned"
    assert items[1]["reflection"] == "被打断"


    with DBSession(engine) as db:
        from sqlmodel import select as ssel
        sess = db.exec(ssel(FocusSession)).first()
        sess.reliance = "product"
        db.add(sess)
        db.commit()
    data2 = client.get("/api/stats/weekly").json()
    assert data2["self_rate"] == 0.0


def test_weekly_reliance_empty(client):
    """没有任何完成场次时 self_rate 为 null。"""
    data = client.get("/api/stats/weekly").json()
    assert data["self_rate"] is None


def test_insights(client):
    _seed_today()
    data = client.get("/api/stats/insights").json()
    assert data["total_distractions"] >= 1
    assert data["worst_hours"][0]["hour"] == 20
    assert data["auto_detected"] >= 1


def test_qualified_by_daily_total(client):
    """达标按当天累计：两场短会话合计达标（单场都不够，当天够）。"""
    with DBSession(engine) as db:
        uid = default_user_id()
        for i, mins in enumerate((7, 8)):
            s = FocusSession(task_name="短场", planned_minutes=5, status="running",
                             started_at=datetime.combine(date.today(), time(9 + i, 0)), user_id=uid)
            db.add(s)
            db.commit()
            db.refresh(s)
            s.status = "completed"
            s.ended_at = s.started_at + timedelta(minutes=mins)
            s.actual_minutes = mins
            s.completion_score = 70
            s.flow_score = 4
            db.add(s)
        db.commit()
    data = client.get("/api/stats/daily").json()
    assert data["focus_minutes"] == 15
    assert data["qualified"] is True


def test_not_qualified_when_daily_total_below_threshold(client):
    """当天累计不足目标 80% → 未达标。"""
    with DBSession(engine) as db:
        uid = default_user_id()
        s = FocusSession(task_name="短场", planned_minutes=15, status="running",
                         started_at=datetime.combine(date.today(), time(10, 0)), user_id=uid)
        db.add(s)
        db.commit()
        db.refresh(s)
        s.status = "completed"
        s.ended_at = s.started_at + timedelta(minutes=5)
        s.actual_minutes = 5
        s.completion_score = 90
        db.add(s)
        db.commit()
    data = client.get("/api/stats/daily").json()
    assert data["qualified"] is False
