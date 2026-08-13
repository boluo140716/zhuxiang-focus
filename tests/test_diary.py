"""日记 API 测试：按日期读写、覆盖、用户隔离。"""


def test_get_empty_diary(client):
    r = client.get("/api/diary", params={"date": "2026-08-08"})
    assert r.status_code == 200
    assert r.json() == {"date": "2026-08-08", "content": ""}


def test_save_and_get(client):
    r = client.put("/api/diary", json={"date": "2026-08-08", "content": "今天写完了周报。"})
    assert r.status_code == 200
    assert r.json()["content"] == "今天写完了周报。"
    r2 = client.get("/api/diary", params={"date": "2026-08-08"})
    assert r2.json()["content"] == "今天写完了周报。"


def test_save_overwrite(client):
    client.put("/api/diary", json={"date": "2026-08-08", "content": "第一版"})
    r = client.put("/api/diary", json={"date": "2026-08-08", "content": "第二版"})
    assert r.json()["content"] == "第二版"
    assert client.get("/api/diary", params={"date": "2026-08-08"}).json()["content"] == "第二版"


def test_diary_user_isolation(client):
    """不同用户的日记互不可见。"""
    client.put("/api/diary", json={"date": "2026-08-08", "content": "甲的日记"})
    r = client.post("/api/auth/register", json={"username": "other", "password": "secret1"})
    token = r.json()["token"]
    r2 = client.get("/api/diary", params={"date": "2026-08-08"}, headers={"Authorization": f"Bearer {token}"})
    assert r2.json()["content"] == ""


def test_search_diary(client):
    client.put("/api/diary", json={"date": "2026-08-01", "content": "去爬山，风景很好"})
    client.put("/api/diary", json={"date": "2026-08-05", "content": "写了周报"})
    r = client.get("/api/diary/search", params={"q": "爬山"})
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1 and items[0]["date"] == "2026-08-01"
    assert client.get("/api/diary/search", params={"q": "不存在"}).json()["items"] == []


def test_search_diary_user_isolation(client):
    client.put("/api/diary", json={"date": "2026-08-01", "content": "甲的爬山记录"})
    r = client.post("/api/auth/register", json={"username": "other2", "password": "secret1"})
    token = r.json()["token"]
    r2 = client.get("/api/diary/search", params={"q": "爬山"}, headers={"Authorization": f"Bearer {token}"})
    assert r2.json()["items"] == []
