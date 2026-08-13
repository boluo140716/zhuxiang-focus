"""待办 API 测试：增删改、打卡项目、每日重置、完成联动。"""
from datetime import datetime, timedelta

from sqlmodel import Session as DBSession, select

from app.db import engine
from app.models import Todo


def _texts(client):
    return [t["text"] for t in client.get("/api/todos").json() if not t["done"]]


def test_create_list_new_first(client):
    client.post("/api/todos", json={"text": "A"})
    client.post("/api/todos", json={"text": "B"})
    client.post("/api/todos", json={"text": "C"})
    assert _texts(client) == ["C", "B", "A"]


def test_update_text_and_done(client):
    tid = client.post("/api/todos", json={"text": "写周报"}).json()["id"]
    r = client.patch(f"/api/todos/{tid}", json={"text": "写季度周报"})
    assert r.status_code == 200
    assert r.json()["text"] == "写季度周报"
    r2 = client.patch(f"/api/todos/{tid}", json={"done": True})
    assert r2.status_code == 200
    assert r2.json()["done"] is True
    assert _texts(client) == []  # 普通待办完成即隐藏


def test_update_empty_text_rejected(client):
    tid = client.post("/api/todos", json={"text": "X"}).json()["id"]
    assert client.patch(f"/api/todos/{tid}", json={"text": "   "}).status_code == 400


def test_delete(client):
    tid = client.post("/api/todos", json={"text": "删我"}).json()["id"]
    assert client.delete(f"/api/todos/{tid}").status_code == 200
    assert client.delete(f"/api/todos/{tid}").status_code == 404
    assert _texts(client) == []


def test_ownership_isolation(client):
    tid = client.post("/api/todos", json={"text": "我的"}).json()["id"]
    other = client.post("/api/auth/register", json={"username": "other", "password": "secret123"}).json()["token"]
    h = {"Authorization": f"Bearer {other}"}
    assert client.patch(f"/api/todos/{tid}", json={"text": "抢"}, headers=h).status_code == 404
    assert client.delete(f"/api/todos/{tid}", headers=h).status_code == 404
    assert client.get("/api/todos", headers=h).json() == []


def test_toggle_daily(client):
    tid = client.post("/api/todos", json={"text": "喝水"}).json()["id"]
    r = client.patch(f"/api/todos/{tid}", json={"is_daily": True})
    assert r.json()["is_daily"] is True
    assert client.patch(f"/api/todos/{tid}", json={"is_daily": False}).json()["is_daily"] is False


def test_daily_manual_checkin_and_streak(client):
    tid = client.post("/api/todos", json={"text": "晨跑"}).json()["id"]
    client.patch(f"/api/todos/{tid}", json={"is_daily": True})
    r = client.patch(f"/api/todos/{tid}", json={"done": True})
    data = r.json()
    assert data["done"] is True
    assert data["streak"] == 1
    assert data["done_date"] == datetime.now().strftime("%Y-%m-%d")
    # 幂等：再完成一次不重复累计
    assert client.patch(f"/api/todos/{tid}", json={"done": True}).json()["streak"] == 1
    # 模拟昨天打过卡，今天再完成 → 连续 2 天
    with DBSession(engine) as db:
        t = db.get(Todo, tid)
        t.last_checkin = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        t.done = False
        t.done_date = None
        db.commit()
    r2 = client.patch(f"/api/todos/{tid}", json={"done": True})
    assert r2.json()["streak"] == 2
    # 断档：昨天没打，今天打 → 重新从 1 开始
    with DBSession(engine) as db:
        t = db.get(Todo, tid)
        t.last_checkin = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d")
        t.done = False
        t.done_date = None
        db.commit()
    assert client.patch(f"/api/todos/{tid}", json={"done": True}).json()["streak"] == 1


def test_daily_reset_on_read(client):
    tid = client.post("/api/todos", json={"text": "冥想"}).json()["id"]
    client.patch(f"/api/todos/{tid}", json={"is_daily": True})
    client.patch(f"/api/todos/{tid}", json={"done": True})
    with DBSession(engine) as db:
        t = db.get(Todo, tid)
        t.done_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        db.commit()
    data = [t for t in client.get("/api/todos").json() if t["id"] == tid][0]
    assert data["done"] is False  # 昨日完成 → 读取时重置为今天未完成
    assert data["streak"] == 1  # 连续天数保留
    assert data["done_date"] is None


def test_normal_done_no_streak(client):
    tid = client.post("/api/todos", json={"text": "一次性的"}).json()["id"]
    assert client.patch(f"/api/todos/{tid}", json={"done": True}).json()["streak"] == 0


def test_session_complete_marks_todo(client):
    tid = client.post("/api/todos", json={"text": "读 20 页"}).json()["id"]
    sid = client.post("/api/sessions", json={"task_name": "读 20 页", "todo_id": tid}).json()["id"]
    client.patch(f"/api/sessions/{sid}", json={"action": "complete"})
    with DBSession(engine) as db:
        t = db.get(Todo, tid)
        assert t.done is True
        assert t.done_date == datetime.now().strftime("%Y-%m-%d")


def test_session_complete_daily_streak(client):
    tid = client.post("/api/todos", json={"text": "写作"}).json()["id"]
    client.patch(f"/api/todos/{tid}", json={"is_daily": True})
    sid = client.post("/api/sessions", json={"task_name": "写作", "todo_id": tid}).json()["id"]
    client.patch(f"/api/sessions/{sid}", json={"action": "complete"})
    with DBSession(engine) as db:
        assert db.get(Todo, tid).streak == 1


def test_session_abandon_keeps_todo(client):
    tid = client.post("/api/todos", json={"text": "写方案"}).json()["id"]
    sid = client.post("/api/sessions", json={"task_name": "写方案", "todo_id": tid}).json()["id"]
    client.patch(f"/api/sessions/{sid}", json={"action": "abandon"})
    with DBSession(engine) as db:
        assert db.get(Todo, tid).done is False

def test_create_daily_todo(client):
    """每日添加框创建的就是每日任务（is_daily=True）。"""
    r = client.post("/api/todos", json={"text": "晨跑", "is_daily": True})
    assert r.status_code == 200
    data = r.json()
    assert data["text"] == "晨跑"
    assert data["is_daily"] is True
    assert data["streak"] == 0


def test_create_normal_todo_defaults(client):
    """普通添加框不带 is_daily -> 默认普通待办。"""
    r = client.post("/api/todos", json={"text": "读 20 页"})
    assert r.json()["is_daily"] is False