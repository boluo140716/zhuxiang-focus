"""认证与数据隔离测试：注册/登录/JWT/首账号继承/按用户隔离/监控内部端点。"""
import base64
import json as _json

from fastapi.testclient import TestClient
from sqlmodel import Session as DBSession, delete, select

from app import models
from app.db import engine
from app.main import app
from app.models import Distraction, FocusSession, Setting, User
from tests.conftest import TEST_PASSWORD, TEST_USERNAME, default_user_id


def _clean_all():
    with DBSession(engine) as db:
        for model in (models.User, models.FocusSession, models.Distraction, models.Setting):
            db.exec(delete(model))
        db.commit()


def _token_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_register_returns_token_and_user(client):
    r = client.post("/api/auth/register", json={"username": "alice", "nickname": "爱丽丝", "password": "secret1"})
    assert r.status_code == 200
    data = r.json()
    assert data["token"]
    assert data["user"]["username"] == "alice"
    assert data["user"]["nickname"] == "爱丽丝"


def test_security_reset_flow(client):
    """设置安全问题 → 忘记密码 → 回答正确重置 → 新密码登录。"""
    r = client.post("/api/auth/security", json={"question": "你最喜欢的城市是？", "answer": "杭州"})
    assert r.status_code == 200
    q = client.get("/api/auth/security-question", params={"username": TEST_USERNAME})
    assert q.json()["question"] == "你最喜欢的城市是？"
    # 错误答案
    r2 = client.post("/api/auth/reset-password", json={"username": TEST_USERNAME, "answer": "北京", "new_password": "newpass1"})
    assert r2.status_code == 400
    # 正确答案重置
    r3 = client.post("/api/auth/reset-password", json={"username": TEST_USERNAME, "answer": "杭州", "new_password": "newpass1"})
    assert r3.json()["ok"] is True
    # 新密码可登录
    r4 = client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": "newpass1"})
    assert r4.status_code == 200


def test_reset_password_unset_security(client):
    """未设置安全问题无法获取问题/重置。"""
    r = client.get("/api/auth/security-question", params={"username": TEST_USERNAME})
    assert r.status_code == 404
    r2 = client.post("/api/auth/reset-password", json={"username": TEST_USERNAME, "answer": "x", "new_password": "newpass1"})
    assert r2.status_code == 404


def test_register_duplicate_username(client):
    r = client.post("/api/auth/register", json={"username": TEST_USERNAME, "nickname": "x", "password": "secret1"})
    assert r.status_code == 409
    assert "已被使用" in r.json()["detail"]


def test_register_short_password(client):
    r = client.post("/api/auth/register", json={"username": "bob", "nickname": "", "password": "123"})
    assert r.status_code == 400
    assert "至少 6 位" in r.json()["detail"]


def test_register_empty_username(client):
    r = client.post("/api/auth/register", json={"username": "   ", "nickname": "", "password": "secret1"})
    assert r.status_code == 400


def test_login_ok(client):
    r = client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": TEST_PASSWORD})
    assert r.status_code == 200
    assert r.json()["user"]["username"] == TEST_USERNAME


def test_login_wrong_password_same_message(client):
    r1 = client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": "wrong-pass"})
    r2 = client.post("/api/auth/login", json={"username": "ghost-user", "password": "wrong-pass"})
    assert r1.status_code == r2.status_code == 401
    assert r1.json()["detail"] == r2.json()["detail"]  # 不泄露是用户名还是密码错


def test_me_requires_token(client):
    assert client.get("/api/auth/me").status_code == 200  # conftest 已带头
    bare = TestClient(app)
    assert bare.get("/api/auth/me").status_code == 401
    fake = TestClient(app)
    fake.headers.update(_token_header("not-a-real-token"))
    assert fake.get("/api/auth/me").status_code == 401


def test_tampered_token_rejected(client):
    token = client.headers["Authorization"].split(" ")[1]
    header, payload, sig = token.split(".")
    data = _json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    data["uid"] = 99999
    forged = base64.urlsafe_b64encode(_json.dumps(data).encode()).rstrip(b"=").decode("ascii")
    bad = TestClient(app)
    bad.headers.update(_token_header(f"{header}.{forged}.{sig}"))
    assert bad.get("/api/auth/me").status_code == 401


def test_password_not_stored_plaintext(client):
    with DBSession(engine) as db:
        user = db.exec(select(User).where(User.username == TEST_USERNAME)).first()
    assert "$" in user.password_hash
    assert TEST_PASSWORD not in user.password_hash


def test_user_isolation(client):
    """用户 A 的数据用户 B 完全看不到、改不了。"""
    r = client.post("/api/sessions", json={"task_name": "Tester 的会话"})
    sid = r.json()["id"]
    alice = client.post("/api/auth/register", json={"username": "alice", "nickname": "A", "password": "secret1"}).json()
    alice_c = TestClient(app)
    alice_c.headers.update(_token_header(alice["token"]))
    assert alice_c.get("/api/sessions/current").json() is None
    assert alice_c.get("/api/stats/daily").json()["total_sessions"] == 0
    assert alice_c.get("/api/stats/weekly").json()["streak"] == 0
    assert alice_c.patch(f"/api/sessions/{sid}", json={"action": "complete"}).status_code == 404
    # 设置隔离：tester 改深度时段，alice 仍默认
    client.put("/api/settings", json={"deep_start": "08:00"})
    assert client.get("/api/settings").json()["deep_start"] == "08:00"
    assert alice_c.get("/api/settings").json()["deep_start"] == "09:00"


def test_running_constraint_per_user(client):
    """每人同时最多一场 running：B 开始不影响 A 的会话。"""
    a = client.post("/api/sessions", json={"task_name": "A 的会话"}).json()
    alice = client.post("/api/auth/register", json={"username": "alice2", "nickname": "A2", "password": "secret1"}).json()
    alice_c = TestClient(app)
    alice_c.headers.update(_token_header(alice["token"]))
    alice_c.post("/api/sessions", json={"task_name": "Alice2 的会话"})
    assert client.get("/api/sessions/current").json()["id"] == a["id"]
    with DBSession(engine) as db:
        a_db = db.get(FocusSession, a["id"])
        assert a_db.status == "running"


def test_first_user_inherits_orphan_data():
    """库中无任何用户时，首个注册账号继承全部历史无主数据。"""
    _clean_all()
    with DBSession(engine) as db:
        db.add(FocusSession(task_name="旧会话", planned_minutes=15, status="completed", actual_minutes=20, completion_score=70, flow_score=4, user_id=None))
        db.add(Setting(key="target_minutes", value="20", user_id=None))
        db.commit()
    with TestClient(app) as c:
        r = c.post("/api/auth/register", json={"username": "first", "nickname": "第一", "password": "secret1"})
        assert r.status_code == 200
        first_id = r.json()["user"]["id"]
    with DBSession(engine) as db:
        sessions = db.exec(select(FocusSession)).all()
        settings = db.exec(select(Setting)).all()
    assert len(sessions) == 1 and sessions[0].user_id == first_id
    assert len(settings) == 1 and settings[0].user_id == first_id
    # 第二人注册不继承
    with TestClient(app) as c2:
        r2 = c2.post("/api/auth/register", json={"username": "second", "nickname": "第二", "password": "secret1"})
        assert r2.status_code == 200
    with DBSession(engine) as db:
        sessions = db.exec(select(FocusSession)).all()
    assert sessions[0].user_id == first_id  # 仍归第一人


def test_me_has_created_at(client):
    """me 响应包含注册日期（个人中心身份卡用）。"""
    data = client.get("/api/auth/me").json()
    assert data["created_at"]


def test_update_nickname(client):
    r = client.patch("/api/auth/me", json={"nickname": "新昵称"})
    assert r.status_code == 200
    assert r.json()["nickname"] == "新昵称"
    assert client.get("/api/auth/me").json()["nickname"] == "新昵称"
    assert client.patch("/api/auth/me", json={"nickname": "   "}).status_code == 400


def test_change_password(client):
    r = client.post("/api/auth/password", json={"old_password": TEST_PASSWORD, "new_password": "newpass1"})
    assert r.status_code == 200 and r.json()["ok"] is True
    # 旧密码登录失败，新密码登录成功
    assert client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": TEST_PASSWORD}).status_code == 401
    assert client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": "newpass1"}).status_code == 200
    # 旧密码错 / 新密码过短
    assert client.post("/api/auth/password", json={"old_password": "wrong-old", "new_password": "newpass2"}).status_code == 400
    assert client.post("/api/auth/password", json={"old_password": "newpass1", "new_password": "123"}).status_code == 400


def test_summary(client):
    """个人中心累计履历聚合正确。"""
    client.put("/api/settings", json={"target_minutes": 15})
    # 一场完成的达标会话（靠自己）+ 一场分心
    with DBSession(engine) as db:
        from datetime import datetime, timedelta
        s = FocusSession(task_name="累计", planned_minutes=15, status="completed", actual_minutes=25,
                         completion_score=80, flow_score=4, reliance="self", user_id=default_user_id(),
                         started_at=datetime.now() - timedelta(days=2), ended_at=datetime.now() - timedelta(days=2) + timedelta(minutes=25))
        db.add(s)
        db.add(Distraction(source="auto_detect", app_name="抖音", user_id=default_user_id()))
        db.commit()
    data = client.get("/api/auth/summary").json()
    assert data["total_focus_minutes"] == 25
    assert data["total_completed"] == 1
    assert data["total_distractions"] == 1
    assert data["qualified_days"] == 1  # 25>=12 且完成度 80
    assert data["self_rate"] == 1.0


def test_summary_empty(client):
    data = client.get("/api/auth/summary").json()
    assert data["total_completed"] == 0 and data["self_rate"] is None


def test_monitor_internal_endpoints(client):
    """监控内部端点：active_session / settings / distraction。"""
    sid = client.post("/api/sessions", json={"task_name": "监控测试"}).json()["id"]
    active = client.get("/api/monitor/active_session").json()
    assert active["id"] == sid and active["user_id"] == default_user_id()
    st = client.get(f"/api/monitor/settings?user_id={default_user_id()}").json()
    assert "blacklist" in st and "naked_day" in st
    r = client.post("/api/monitor/distraction", json={"session_id": sid, "app_name": "抖音"})
    assert r.json()["ok"] is True
    with DBSession(engine) as db:
        d = db.exec(select(Distraction)).first()
        assert d.session_id == sid and d.source == "auto_detect" and d.app_name == "抖音"
        assert d.user_id == default_user_id()
    # 上报到已结束会话被忽略
    client.patch(f"/api/sessions/{sid}", json={"action": "abandon"})
    r2 = client.post("/api/monitor/distraction", json={"session_id": sid, "app_name": "抖音"})
    assert r2.json()["ok"] is False
