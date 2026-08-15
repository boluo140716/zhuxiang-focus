"""认证 API：注册 / 登录 / 当前用户。"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlmodel import Session as DBSession, select

from app.db import AVATAR_DIR, get_session
from app.deps import get_current_user
from app.models import Diary, Distraction, FocusSession, Setting, Todo, User
from app.schemas import AuthLogin, AuthRegister, NicknameUpdate, PasswordChange, ResetPassword, SecuritySet
from app.services import training as training_service
from app.services.auth import create_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_payload(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "nickname": user.nickname,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


def _inherit_orphan_data(db: DBSession, user_id: str) -> None:
    """首个用户注册时，把历史无主数据（user_id IS NULL）全部归属该账号。"""
    for model in (FocusSession, Distraction, Setting, Todo, Diary):
        for row in db.exec(select(model).where(model.user_id.is_(None))).all():
            row.user_id = user_id
            db.add(row)
    db.commit()


@router.post("/register")
def register(body: AuthRegister, db: DBSession = Depends(get_session)):
    """注册：用户名唯一；库中无任何用户时，该账号自动继承历史数据。"""
    username = body.username.strip()
    nickname = body.nickname.strip() or username
    if not username:
        raise HTTPException(400, "用户名不能为空")
    if len(body.password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    if db.exec(select(User).where(User.username == username)).first():
        raise HTTPException(409, "用户名已被使用")
    first_user = db.exec(select(User)).first() is None
    user = User(username=username, nickname=nickname, password_hash=hash_password(body.password))
    if body.security_question and body.security_answer:
        user.security_question = body.security_question.strip()
        user.security_answer_hash = hash_password(body.security_answer.strip().lower())
    db.add(user)
    db.commit()
    db.refresh(user)
    if first_user:
        _inherit_orphan_data(db, user.id)
    return {"token": create_token(user.id), "user": _user_payload(user)}


@router.post("/login")
def login(body: AuthLogin, db: DBSession = Depends(get_session)):
    """登录：用户名或密码错误统一提示，不泄露具体是哪个。"""
    user = db.exec(select(User).where(User.username == body.username.strip())).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "用户名或密码不正确")
    return {"token": create_token(user.id), "user": _user_payload(user)}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    """当前登录用户（前端启动时校验 token 用）。"""
    return _user_payload(user)


@router.patch("/me")
def update_profile(body: NicknameUpdate, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """修改昵称（登录态保持；用户名不可改）。"""
    nickname = body.nickname.strip()
    if not nickname:
        raise HTTPException(400, "昵称不能为空")
    if len(nickname) > 50:
        raise HTTPException(400, "昵称最长 50 字")
    user.nickname = nickname
    db.add(user)
    db.commit()
    db.refresh(user)
    return _user_payload(user)


@router.post("/password")
def change_password(body: PasswordChange, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """修改密码：必须验证旧密码；改完由前端强制重新登录。"""
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(400, "旧密码不正确")
    if len(body.new_password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    user.password_hash = hash_password(body.new_password)
    db.add(user)
    db.commit()
    return {"ok": True}


@router.post("/security")
def set_security(body: SecuritySet, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """设置/更新安全问题（忘记密码重置用）。"""
    question = body.question.strip()
    answer = body.answer.strip()
    if not question:
        raise HTTPException(400, "请选择安全问题")
    if not answer:
        raise HTTPException(400, "请填写答案")
    user.security_question = question
    user.security_answer_hash = hash_password(answer.lower())
    db.add(user)
    db.commit()
    return {"ok": True}


@router.get("/security-question")
def security_question(username: str, db: DBSession = Depends(get_session)):
    """忘记密码第一步：按用户名取安全问题（未设置则 404）。"""
    user = db.exec(select(User).where(User.username == username.strip())).first()
    if not user or not user.security_question:
        raise HTTPException(404, "该用户名未设置安全问题")
    return {"question": user.security_question}


@router.post("/reset-password")
def reset_password(body: ResetPassword, db: DBSession = Depends(get_session)):
    """忘记密码第二步：回答安全问题正确后重置密码。"""
    user = db.exec(select(User).where(User.username == body.username.strip())).first()
    if not user or not user.security_answer_hash:
        raise HTTPException(404, "该用户名未设置安全问题")
    if not verify_password(body.answer.strip().lower(), user.security_answer_hash):
        raise HTTPException(400, "答案不正确")
    if len(body.new_password) < 6:
        raise HTTPException(400, "新密码至少 6 位")
    user.password_hash = hash_password(body.new_password)
    db.add(user)
    db.commit()
    return {"ok": True}


@router.post("/me/avatar")
async def upload_avatar(file: UploadFile, user: User = Depends(get_current_user)):
    """上传头像（图片类型、≤5MB），保存为 data/avatars/{用户id}.png。"""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "请选择图片文件")
    data = await file.read()
    if not data:
        raise HTTPException(400, "文件为空")
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(400, "图片不能超过 5MB")
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    (AVATAR_DIR / f"{user.id}.png").write_bytes(data)
    return {"ok": True, "url": f"/avatars/{user.id}.png"}


@router.get("/summary")
def summary(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """个人中心累计履历：从注册至今的累计数据（与统计页的近期数据错开）。"""
    sessions = db.exec(select(FocusSession).where(FocusSession.user_id == user.id)).all()
    distractions = db.exec(select(Distraction).where(Distraction.user_id == user.id)).all()
    completed = [s for s in sessions if s.status == "completed"]
    rated = [s for s in completed if s.reliance in ("self", "product")]
    qualified = training_service.qualified_days(sessions)
    return {
        "total_focus_minutes": sum(s.actual_minutes for s in completed),
        "total_completed": len(completed),
        "total_distractions": len(distractions),
        "qualified_days": len(qualified),
        "self_rate": (sum(1 for s in rated if s.reliance == "self") / len(rated)) if rated else None,
    }
