"""回神仪式档位算法测试（连续破功 / 三档状态机）。"""
from datetime import date, datetime, timedelta

from app.services.stage import STAGE_L1, STAGE_L2, STAGE_L3, settle_stage


class FakeDistraction:
    def __init__(self, day: date, hour=10, minute=0):
        self.occurred_at = datetime(day.year, day.month, day.day, hour, minute)


def _cluster(day, minute2):
    """当天 10:00 与 10:minute2 两次破功。"""
    return [FakeDistraction(day, 10, 0), FakeDistraction(day, 10, minute2)]


def test_no_records_keep_stage():
    assert settle_stage(STAGE_L1, [], date(2026, 8, 7)) == STAGE_L1
    assert settle_stage(STAGE_L3, [], date(2026, 8, 7)) == STAGE_L3


def test_cluster_today_escalates_to_l1():
    today = date(2026, 8, 7)
    assert settle_stage(STAGE_L3, _cluster(today, 5), today) == STAGE_L1


def test_cluster_boundary_exactly_10min():
    today = date(2026, 8, 7)
    assert settle_stage(STAGE_L3, _cluster(today, 10), today) == STAGE_L1  # <= 10 分钟算连续


def test_cluster_over_10min_not_counted():
    """超过 10 分钟不算连续 -> 不升档；且当天无连续破功。"""
    today = date(2026, 8, 7)
    beyond = _cluster(today, 11)
    assert settle_stage(STAGE_L3, beyond, today) == STAGE_L3


def test_cluster_cross_day_not_counted():
    """跨天（前一天 23:59 + 今天 00:05）不算连续破功。"""
    today = date(2026, 8, 7)
    yesterday = today - timedelta(days=1)
    recs = [FakeDistraction(yesterday, 23, 59), FakeDistraction(today, 0, 5)]
    assert settle_stage(STAGE_L3, recs, today) == STAGE_L3


def test_l1_to_l2_after_3_days_no_cluster():
    """L1：距上次连续破功 >= 3 天 -> L2。"""
    today = date(2026, 8, 7)
    cluster_day = today - timedelta(days=3)  # 8/4 连续破功，8/5/6/7 无 -> 连续 3 天
    recs = _cluster(cluster_day, 5)
    assert settle_stage(STAGE_L1, recs, today) == STAGE_L2


def test_l1_stays_when_cluster_recent():
    today = date(2026, 8, 7)
    cluster_day = today - timedelta(days=2)
    recs = _cluster(cluster_day, 5)
    assert settle_stage(STAGE_L1, recs, today) == STAGE_L1


def test_l2_to_l3_after_7_days_no_distraction():
    today = date(2026, 8, 7)
    recs = [FakeDistraction(today - timedelta(days=7))]
    assert settle_stage(STAGE_L2, recs, today) == STAGE_L3


def test_l2_stays_when_recent_distraction():
    today = date(2026, 8, 7)
    recs = [FakeDistraction(today - timedelta(days=3))]
    assert settle_stage(STAGE_L2, recs, today) == STAGE_L2


def test_l1_not_jump_to_l3():
    """逐级降档：L1 即使 7 天无破功也只降 L2。"""
    today = date(2026, 8, 7)
    recs = [FakeDistraction(today - timedelta(days=7))]
    assert settle_stage(STAGE_L1, recs, today) == STAGE_L2


def test_escalation_overrides_l3():
    """升档回退：L3 今天连续破功 -> 直接回 L1。"""
    today = date(2026, 8, 7)
    assert settle_stage(STAGE_L3, _cluster(today, 5), today) == STAGE_L1


def test_no_cluster_history_anchor_from_first_record():
    """从未连续破功：从首次有记录那天起算观察期（4 天 >= 3 -> L2）。"""
    today = date(2026, 8, 7)
    first = today - timedelta(days=4)
    recs = [FakeDistraction(first), FakeDistraction(today - timedelta(days=2))]
    assert settle_stage(STAGE_L1, recs, today) == STAGE_L2


def test_fresh_user_stays_l1():
    """首次记录就是今天且无连续破功 -> 观察期不足，保持 L1。"""
    today = date(2026, 8, 7)
    recs = [FakeDistraction(today)]
    assert settle_stage(STAGE_L1, recs, today) == STAGE_L1


"""接口测试：GET /api/settings/ritual-stage。"""
from datetime import datetime, timedelta

from sqlmodel import Session as DBSession, select

from app.db import engine
from app.models import Distraction, Setting
from tests.conftest import default_user_id


def test_ritual_stage_api_default(client):
    r = client.get("/api/settings/ritual-stage")
    assert r.status_code == 200
    data = r.json()
    assert data["stage"] == 1
    assert data["today_count"] == 0


def test_ritual_stage_api_cluster_today(client):
    """L3 档位 + 今天连续破功 -> 升回 L1 且写回 Setting；today_count 正确。"""
    uid = default_user_id()
    now = datetime.now()
    with DBSession(engine) as db:
        db.add(Setting(key="ritual_stage", value="3", user_id=uid))
        db.add(Distraction(user_id=uid, occurred_at=now - timedelta(minutes=5), source="manual"))
        db.add(Distraction(user_id=uid, occurred_at=now, source="auto_detect", app_name="bilibili"))
        db.commit()
    r = client.get("/api/settings/ritual-stage")
    assert r.status_code == 200
    data = r.json()
    assert data["stage"] == 1
    assert data["today_count"] == 2
    with DBSession(engine) as db:
        row = db.exec(select(Setting).where(Setting.key == "ritual_stage")).first()
        assert row is not None and row.value == "1"  # 已写回