"""待办 API：增删改 + 完成标记 + 打卡项目（每日重复）。"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Todo, User
from app.schemas import TodoCreate, TodoUpdate

router = APIRouter(prefix="/api/todos", tags=["todos"])


def _own(db: DBSession, todo_id: str, user: User) -> Todo:
    todo = db.get(Todo, todo_id)
    if not todo or todo.user_id != user.id or todo.deleted:
        raise HTTPException(404, "待办不存在")
    return todo


def _all(db: DBSession, user_id: str):
    return db.exec(
        select(Todo).where(Todo.user_id == user_id, Todo.deleted == False).order_by(Todo.sort_order, Todo.id)
    ).all()


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _reset_stale_daily(db: DBSession, user_id: str) -> None:
    """读取列表时：打卡项目里"昨天完成"的自动重置为今天未完成（连续天数保留）。"""
    today = _today()
    items = db.exec(
        select(Todo).where(
            Todo.user_id == user_id, Todo.deleted == False, Todo.is_daily == True, Todo.done == True
        )
    ).all()
    changed = False
    for t in items:
        if t.done_date != today:
            t.done = False
            t.done_date = None
            db.add(t)
            changed = True
    if changed:
        db.commit()


@router.get("")
def list_todos(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    _reset_stale_daily(db, user.id)
    return _all(db, user.id)


@router.post("", response_model=Todo)
def create_todo(body: TodoCreate, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """新增待办，排在最前（sort_order = 当前最小 - 1）。"""
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "待办内容不能为空")
    first = db.exec(select(Todo).where(Todo.user_id == user.id).order_by(Todo.sort_order)).first()
    order = (first.sort_order - 1) if first else 0
    todo = Todo(text=text, sort_order=order, is_daily=body.is_daily, user_id=user.id)
    db.add(todo)
    db.commit()
    db.refresh(todo)
    return todo


@router.patch("/{todo_id}", response_model=Todo)
def update_todo(
    todo_id: str, body: TodoUpdate, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)
):
    """改文字 / 打卡开关 / 标记完成（打卡项目记录完成日期并累计连续天数）。"""
    todo = _own(db, todo_id, user)
    if body.text is not None:
        text = body.text.strip()
        if not text:
            raise HTTPException(400, "待办内容不能为空")
        todo.text = text
    if body.is_daily is not None:
        todo.is_daily = body.is_daily
    if body.done is not None:
        if body.done and not todo.done:
            today = _today()
            todo.done = True
            todo.done_date = today
            if todo.is_daily:
                yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
                todo.streak = todo.streak + 1 if todo.last_checkin == yesterday else 1
                todo.last_checkin = today
        elif not body.done:
            todo.done = False
            todo.done_date = None
    todo.updated_at = datetime.now()
    db.add(todo)
    db.commit()
    db.refresh(todo)
    return todo


@router.delete("/{todo_id}")
def delete_todo(todo_id: str, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    todo = _own(db, todo_id, user)
    todo.deleted = True  # 软删除：同步墓碑，查询过滤
    todo.updated_at = datetime.now()
    db.add(todo)
    db.commit()
    return {"ok": True}
