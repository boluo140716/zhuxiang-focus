"""设置 API 测试。"""
from app.services.blacklist import DEFAULT_BLACKLIST


def test_defaults(client):
    data = client.get("/api/settings").json()
    assert data["target_minutes"] == 15
    assert data["blacklist"] == DEFAULT_BLACKLIST
    assert data["reminder_enabled"] is True


def test_partial_update(client):
    r = client.put("/api/settings", json={"target_minutes": 25, "blacklist": ["抖音", "bilibili"]})
    assert r.status_code == 200
    data = r.json()
    assert data["target_minutes"] == 25
    assert data["blacklist"] == ["抖音", "bilibili"]
    # 未提交的键保持默认
    assert data["deep_start"] == "09:00"


def test_unknown_keys_ignored(client):
    data = client.put("/api/settings", json={"not_a_key": 1}).json()
    assert "not_a_key" not in data
