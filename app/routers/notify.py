"""本地系统通知：香尽等事件通过 Windows toast 提醒（浏览器切后台也能收到）。"""
import logging
import os
from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/notify", tags=["notify"])

# 香炉图标路径（用于 Windows toast，PNG 格式兼容性更好）
ICON_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "static", "favicon.png")


class ToastBody(BaseModel):
    title: str = "篆香"
    body: str = ""


@router.post("/toast")
def send_toast(body: ToastBody):
    """发一条 Windows 系统通知；非 Windows / 无桌面环境时静默忽略。"""
    try:
        from winotify import Notification

        Notification(app_id="篆香", title=body.title, msg=body.body, icon=ICON_PATH).show()
    except Exception:
        logger.warning("系统通知发送失败（非桌面环境或 winotify 不可用）", exc_info=True)
    return {"ok": True}
