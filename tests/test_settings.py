"""设置 API 测试。"""
from app.services.blacklist import DEFAULT_BLACKLIST


def test_defaults(client):
    data = client.get("/api/settings").json()
    assert data["blacklist"] == DEFAULT_BLACKLIST
    assert data["reminder_enabled"] is True
    assert data["naked_day"] is None  # 默认不启用裸专注日


def test_partial_update(client):
    r = client.put("/api/settings", json={"deep_start": "08:00", "blacklist": ["抖音", "bilibili"]})
    assert r.status_code == 200
    data = r.json()
    assert data["deep_start"] == "08:00"
    assert data["blacklist"] == ["抖音", "bilibili"]
    # 未提交的键保持默认
    assert data["reminder_enabled"] is True


def test_naked_day_update(client):
    r = client.put("/api/settings", json={"naked_day": 3})  # 周三
    assert r.status_code == 200
    assert r.json()["naked_day"] == 3
    # 可关闭（null）
    r2 = client.put("/api/settings", json={"naked_day": None})
    assert r2.json()["naked_day"] is None


def test_unknown_keys_ignored(client):
    data = client.put("/api/settings", json={"not_a_key": 1}).json()
    assert "not_a_key" not in data


"""毕业接口测试。"""
from datetime import date, datetime, timedelta

from sqlmodel import Session as DBSession

from app.db import engine
from app.models import FocusSession
from tests.conftest import default_user_id


def _seed_17_qualified_days():
    """近 28 天种 17 天达标（score=70, flow=4, reliance=self）。"""
    uid = default_user_id()
    today = date.today()
    with DBSession(engine) as db:
        for i in range(17):
            day = today - timedelta(days=i)
            db.add(FocusSession(
                task_name="t", planned_minutes=25, status="completed", actual_minutes=25,
                completion_score=70, flow_score=4, reliance="self",
                started_at=datetime(day.year, day.month, day.day, 10, 0),
                user_id=uid,
            ))
        db.commit()


def test_graduation_eligible_and_claim(client):
    _seed_17_qualified_days()
    g = client.get("/api/settings/graduation").json()
    assert g["eligible"] is True
    assert g["graduated_at"] is None
    assert g["rate_28d"] >= 0.6
    assert g["self_rate_28d"] >= 0.5
    r = client.post("/api/settings/graduation/claim")
    assert r.status_code == 200
    assert r.json()["graduated_at"] == date.today().isoformat()


def test_graduation_not_eligible(client):
    g = client.get("/api/settings/graduation").json()
    assert g["eligible"] is False
    assert client.post("/api/settings/graduation/claim").status_code == 400


def test_graduated_stage_locked_to_3(client):
    _seed_17_qualified_days()
    client.post("/api/settings/graduation/claim")
    rs = client.get("/api/settings/ritual-stage").json()
    assert rs["stage"] == 3


def test_graduated_monitor_blacklist_empty(client):
    """毕业后监控黑名单置空（不检测）。"""
    client.put("/api/settings", json={"blacklist": ["bilibili"]})
    _seed_17_qualified_days()
    client.post("/api/settings/graduation/claim")
    m = client.get(f"/api/monitor/settings?user_id={default_user_id()}").json()
    assert m["blacklist"] == []


def test_retrain_resets(client):
    _seed_17_qualified_days()
    client.post("/api/settings/graduation/claim")
    assert client.post("/api/settings/graduation/retrain").status_code == 200
    g = client.get("/api/settings/graduation").json()
    assert g["graduated_at"] is None
    rs = client.get("/api/settings/ritual-stage").json()
    assert rs["stage"] == 1  # 回到受训期