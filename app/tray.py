"""系统托盘：关闭桌面窗口后最小化到托盘，可从托盘重新打开或退出。"""
import os
import sys
from pathlib import Path

from PIL import Image
import pystray


def _icon_path() -> str:
    """返回香炉图标路径（优先用打包后的 _internal 路径）。"""
    if getattr(sys, "frozen", False):
        base = Path(sys._MEIPASS) / "static"
    else:
        base = Path(__file__).parent.parent / "static"
    return str(base / "icons" / "icon-512.png")


def create_tray(on_open, on_exit):
    """创建系统托盘图标。

    Args:
        on_open: 回调，用户点击"打开窗口"时调用
        on_exit: 回调，用户点击"退出"时调用
    """
    icon_file = _icon_path()
    try:
        image = Image.open(icon_file)
    except Exception:
        # 降级：用纯色方块
        image = Image.new("RGBA", (64, 64), (160, 100, 60, 255))

    menu = pystray.Menu(
        pystray.MenuItem("打开窗口", on_open, default=True),
        pystray.MenuItem("退出", on_exit),
    )

    tray = pystray.Icon("篆香", image, "篆香", menu)
    return tray
