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


@pytest.fixture()
def client():
    """每个测试前清空数据表。"""
    with DBSession(engine) as db:
        for model in (models.Distraction, models.FocusSession, models.Setting):
            db.exec(delete(model))
        db.commit()
    with TestClient(app) as c:
        yield c
