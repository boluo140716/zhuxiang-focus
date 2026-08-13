"""数据导出/导入测试：完整性、合并、去重、id 冲突、越权。"""
import json


def _export(client, headers=None):
    r = client.get("/api/data/export", headers=headers)
    assert r.status_code == 200
    return r.json()


def _register(client, username):
    r = client.post("/api/auth/register", json={"username": username, "password": "secret1"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _seed_user_a(client):
    """给默认测试用户造一组各类型数据。"""
    client.put("/api/diary", json={"date": "2026-08-01", "content": "第一天"})
    client.put("/api/diary", json={"date": "2026-08-02", "content": "第二天"})
    r = client.post("/api/todos", json={"text": "背单词", "is_daily": True})
    client.patch(f"/api/todos/{r.json()['id']}", json={"done": True})
    client.put("/api/settings", json={"blacklist": ["抖音", "bilibili"]})
    r = client.post("/api/sessions", json={"task_name": "写方案", "planned_minutes": 25})
    sid = r.json()["id"]
    client.post(f"/api/sessions/{sid}/distractions", json={"source": "manual", "resolved_reason": "走神"})
    client.patch(f"/api/sessions/{sid}", json={"action": "complete", "completion_score": 80, "reliance": "self"})


def test_export_contains_all_data(client):
    _seed_user_a(client)
    payload = _export(client)
    assert payload["app"] == "篆香"
    assert payload["schema_version"] == 1
    d = payload["data"]
    assert len(d["diaries"]) == 2
    assert len(d["todos"]) == 1
    assert len(d["sessions"]) == 1
    assert len(d["distractions"]) == 1
    assert d["settings"]["blacklist"] == ["抖音", "bilibili"]
    assert d["sessions"][0]["task_name"] == "写方案"
    assert d["diaries"][0]["date"] == "2026-08-01"
    assert "password_hash" not in json.dumps(payload)


def test_import_into_new_user(client):
    _seed_user_a(client)
    payload = _export(client)
    headers = _register(client, "newbie")
    r = client.post("/api/data/import", json=payload, headers=headers)
    assert r.status_code == 200
    stats = r.json()
    assert stats["imported"]["diaries"] == 2
    assert stats["imported"]["todos"] == 1
    assert stats["imported"]["settings"] >= 1
    r2 = client.get("/api/diary", params={"date": "2026-08-01"}, headers=headers)
    assert r2.json()["content"] == "第一天"
    r3 = client.get("/api/settings", headers=headers)
    assert r3.json()["blacklist"] == ["抖音", "bilibili"]


def test_import_overwrite_diary(client):
    _seed_user_a(client)
    payload = _export(client)
    client.put("/api/diary", json={"date": "2026-08-01", "content": "本地的版本"})
    r = client.post("/api/data/import", json=payload)
    assert r.status_code == 200
    assert client.get("/api/diary", params={"date": "2026-08-01"}).json()["content"] == "第一天"


def test_import_todo_dedup(client):
    _seed_user_a(client)
    payload = _export(client)
    client.post("/api/todos", json={"text": "背单词", "is_daily": True})
    r = client.post("/api/data/import", json=payload)
    stats = r.json()
    assert stats["imported"]["todos"] == 0
    assert stats["skipped"] == 1


def test_import_id_conflict_reassign(client):
    _seed_user_a(client)
    payload = _export(client)
    headers = _register(client, "second")
    b_sid = client.post("/api/sessions", json={"task_name": "B自己的专注"}, headers=headers).json()["id"]
    assert isinstance(b_sid, str) and len(b_sid) > 10  # UUID 主键
    r = client.post("/api/data/import", json=payload, headers=headers)
    assert r.status_code == 200
    stats = r.json()
    assert stats["imported"]["sessions"] == 1
    assert stats["imported"]["distractions"] == 1
    exported = _export(client, headers)
    sessions_b = exported["data"]["sessions"]
    assert len(sessions_b) == 2
    imported_session = next(s for s in sessions_b if s["task_name"] == "写方案")
    assert imported_session["id"] != b_sid  # 不与 B 自己的会话 id 冲突
    imported_dist = exported["data"]["distractions"][0]
    assert imported_dist["session_id"] == imported_session["id"]


def test_import_invalid_version(client):
    r = client.post("/api/data/import", json={"schema_version": 999, "data": {}})
    assert r.status_code == 400


def test_export_user_isolation(client):
    client.put("/api/diary", json={"date": "2026-08-01", "content": "甲的日记"})
    headers = _register(client, "isolation")
    client.put("/api/diary", json={"date": "2026-08-02", "content": "乙的日记"}, headers=headers)
    payload = _export(client, headers)
    assert len(payload["data"]["diaries"]) == 1
    assert payload["data"]["diaries"][0]["date"] == "2026-08-02"
