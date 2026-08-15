"""pytest 夹具：隔离的临时数据库 + 测试客户端。"""
import os
import tempfile

_tmp_dir = tempfile.mkdtemp(prefix="yizhuxiang_test_")
os.environ["FOCUS_DB_PATH"] = os.path.join(_tmp_dir, "test.db")

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session as DBSession, delete

from app import models
from app.db import engine
from app.main import app


TEST_USERNAME = "tester"
TEST_PASSWORD = "secret123"


@pytest.fixture()
def client():
    """每个测试前清空数据表，并注册默认用户（请求自动带登录头）。"""
    with DBSession(engine) as db:
        for model in (models.Distraction, models.FocusSession, models.Setting, models.Todo, models.Diary, models.User):
            db.exec(delete(model))
        db.commit()
    with TestClient(app, base_url="http://127.0.0.1") as c:
        r = c.post("/api/auth/register", json={"username": TEST_USERNAME, "nickname": "测试", "password": TEST_PASSWORD})
        assert r.status_code == 200, r.text
        c.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
        yield c


def default_user_id() -> int:
    """返回默认测试用户的 id（测试种数据时用它归属）。"""
    from sqlmodel import select as ssel

    from app.models import User

    with DBSession(engine) as db:
        return db.exec(ssel(User).where(User.username == TEST_USERNAME)).first().id
