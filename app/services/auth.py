"""认证服务：密码哈希（pbkdf2）+ JWT 签发/验证（标准库实现，零依赖）。

安全设计：
- 密码不落明文，存「随机盐$哈希」，盐每次随机
- JWT 密钥首次启动随机生成，存 data/auth_secret.key（与数据库同目录，备份即复制 data/）
- 无任何硬编码密钥，开源友好
"""
import base64
import hashlib
import hmac
import json
import secrets
import time

from app.db import DB_PATH

TOKEN_TTL = 7 * 24 * 3600  # 通行证有效期 7 天
PBKDF2_ITERATIONS = 200_000
SECRET_FILE = DB_PATH.parent / "auth_secret.key"


def _secret() -> str:
    """读取或生成 JWT 签名密钥（幂等，重启不失效）。"""
    if SECRET_FILE.exists():
        return SECRET_FILE.read_text(encoding="utf-8").strip()
    SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_hex(32)
    SECRET_FILE.write_text(key, encoding="utf-8")
    return key


def hash_password(password: str) -> str:
    """pbkdf2 哈希：返回「盐$十六进制摘要」。"""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """恒定时间校验密码（防时序攻击）。"""
    try:
        salt, expected = stored.split("$", 1)
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS)
    return hmac.compare_digest(digest.hex(), expected)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def create_token(user_id: str, ttl: int = TOKEN_TTL) -> str:
    """签发 JWT（HS256，payload：uid + exp）。"""
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode("utf-8"))
    payload = _b64url(json.dumps({"uid": user_id, "exp": int(time.time()) + ttl}, separators=(",", ":")).encode("utf-8"))
    signing = f"{header}.{payload}"
    sig = _b64url(hmac.new(_secret().encode("utf-8"), signing.encode("ascii"), hashlib.sha256).digest())
    return f"{signing}.{sig}"


def verify_token(token: str):
    """验证 JWT，有效返回用户 id，否则 None。"""
    try:
        header, payload, sig = token.split(".")
        signing = f"{header}.{payload}"
        expected = _b64url(hmac.new(_secret().encode("utf-8"), signing.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        data = json.loads(_b64url_decode(payload))
        if int(data.get("exp", 0)) < time.time():
            return None
        return data["uid"]  # UUID 主键后为字符串；旧 int token 由 db.get 自然查不到而失效
    except Exception:
        return None
