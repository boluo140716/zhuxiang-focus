"""头像上传测试：上传/取图/类型与大小校验。"""
from app.db import AVATAR_DIR

_PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 200


def test_upload_and_fetch_avatar(client):
    r = client.post("/api/auth/me/avatar", files={"file": ("a.png", _PNG, "image/png")})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    me = client.get("/api/auth/me").json()
    assert url == f"/avatars/{me['id']}.png"
    g = client.get(url)
    assert g.status_code == 200
    assert g.headers["content-type"].startswith("image/png")
    p = AVATAR_DIR / f"{me['id']}.png"
    assert p.exists()
    p.unlink(missing_ok=True)


def test_avatar_reject_non_image(client):
    r = client.post("/api/auth/me/avatar", files={"file": ("a.txt", b"hello", "text/plain")})
    assert r.status_code == 400
    assert "图片" in r.json()["detail"]


def test_avatar_reject_oversize(client):
    big = b"1" * (5 * 1024 * 1024 + 1)
    r = client.post("/api/auth/me/avatar", files={"file": ("a.png", big, "image/png")})
    assert r.status_code == 400
    assert "5MB" in r.json()["detail"]


def test_avatar_requires_auth(client):
    r = client.post("/api/auth/me/avatar", files={"file": ("a.png", _PNG, "image/png")}, headers={"Authorization": "Bearer bad"})
    assert r.status_code == 401
