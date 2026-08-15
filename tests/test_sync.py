"""云同步测试：绑定 / 推送 / 拉取合并 / 墓碑 / 自身键排除（mock 云端）。"""
import httpx
from urllib.parse import urlparse


class FakeResp:
    def __init__(self, status, data):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data


class CloudMock:
    """内存版 Worker：/register /login /sync（后写覆盖 + 增量拉取）。"""

    def __init__(self):
        self.users = {}
        self.items = {}  # (type, id) -> {payload, updated_at, deleted}

    def post(self, url, json=None, headers=None, timeout=None, **kwargs):
        path = urlparse(url).path
        if path == "/login":
            if self.users.get(json.get("username")) == json.get("password"):
                return FakeResp(200, {"token": "cloud-token"})
            return FakeResp(401, {"error": "用户名或密码不正确"})
        if path == "/register":
            self.users[json["username"]] = json["password"]
            return FakeResp(200, {"token": "cloud-token"})
        if path == "/sync":
            cursor = json.get("last_sync_at", "")
            pushed = set()
            for c in json.get("changes", []):
                key = (c["entity_type"], c["id"])
                pushed.add(key)
                if key not in self.items or c["updated_at"] > self.items[key]["updated_at"]:
                    self.items[key] = {"payload": c["payload"], "updated_at": c["updated_at"], "deleted": c["deleted"]}
            out = [
                {"id": k[1], "entity_type": k[0], "payload": v["payload"], "updated_at": v["updated_at"], "deleted": v["deleted"]}
                for k, v in self.items.items()
                if v["updated_at"] > cursor and k not in pushed
            ]
            return FakeResp(200, {"server_time": "2026-08-12T00:00:00.000Z", "changes": out})
        return FakeResp(404, {"error": "Not Found"})


BIND = {"url": "https://fake.workers.dev", "username": "clouduser", "password": "secret123"}


def _bind(client, monkeypatch):
    cloud = CloudMock()
    monkeypatch.setattr(httpx, "post", cloud.post)
    r = client.post("/api/sync/bind", json=BIND)
    assert r.status_code == 200, r.text
    assert r.json()["bound"] is True
    return cloud


def test_bind_status_and_first_sync(client, monkeypatch):
    client.put("/api/diary", json={"date": "2026-08-11", "content": "测试日记"})
    cloud = _bind(client, monkeypatch)
    assert cloud.users == {"clouduser": "secret123"}  # 首次自动注册
    assert ("diary", next(k[1] for k in cloud.items if k[0] == "diary")) in cloud.items
    s = client.get("/api/sync/status").json()
    assert s["bound"] is True and s["username"] == "clouduser"


def test_sync_push_and_pull(client, monkeypatch):
    cloud = _bind(client, monkeypatch)
    # 绑定后新增本地数据 → 推送
    client.put("/api/diary", json={"date": "2026-08-12", "content": "新日记"})
    r = client.post("/api/sync/now").json()
    assert r["synced"] is True and r["pushed"] >= 1
    # 另一设备在云端写入一条待办 → 本地拉取
    cloud.items[("todo", "t-remote")] = {
        "payload": {"text": "云端待办", "sort_order": 0, "done": False, "is_daily": False, "streak": 0, "created_at": "2030-01-01T00:00:00.000Z"},
        "updated_at": "2030-01-01T00:00:00.000Z",
        "deleted": False,
    }
    r = client.post("/api/sync/now").json()
    assert r["applied"] >= 1
    todos = client.get("/api/todos").json()
    assert any(t["text"] == "云端待办" for t in todos)


def test_sync_deleted_todo_tombstone(client, monkeypatch):
    cloud = _bind(client, monkeypatch)
    tid = client.post("/api/todos", json={"text": "要删的"}).json()["id"]
    client.delete(f"/api/todos/{tid}")
    r = client.post("/api/sync/now").json()
    assert r["synced"] is True
    assert cloud.items[("todo", tid)]["deleted"] is True


def test_sync_excludes_cloud_keys(client, monkeypatch):
    cloud = _bind(client, monkeypatch)
    client.put("/api/settings", json={"blacklist": ["抖音"]})
    client.post("/api/sync/now")
    keys = {k for k in cloud.items if k[0] == "setting"}
    assert ("setting", "blacklist") in keys
    assert ("setting", "cloud_bind") not in keys
    assert ("setting", "cloud_cursor") not in keys


def test_sync_requires_https_url(client, monkeypatch):
    r = client.post("/api/sync/bind", json={"url": "http://insecure", "username": "a", "password": "secret123"})
    assert r.status_code == 400


def test_unbind(client, monkeypatch):
    _bind(client, monkeypatch)
    r = client.post("/api/sync/unbind").json()
    assert r["ok"] is True
    assert client.get("/api/sync/status").json()["bound"] is False
