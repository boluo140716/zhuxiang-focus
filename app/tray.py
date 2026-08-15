"""系统托盘：关闭桌面窗口后最小化到托盘，可从托盘重新打开或退出。"""
import os
import sys
from pathlib import Path

from PIL import Image
import pystray


def _icon_path() -> str:
    """返回香炉图标路径（优先用打包后的 _internal 路径）。"""
    if getattr(sys, "frozen", False):
        # PyInstaller onedir：_MEIPASS 指向 _internal 目录
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
        # 确保是 RGBA 模式（pystray 要求）
        if image.mode != "RGBA":
            image = image.convert("RGBA")
    except Exception as e:
        # 降级：用纯色方块
        image = Image.new("RGBA", (64, 64), (160, 100, 60, 255))
        try:
            from datetime import datetime
            from pathlib import Path
            base = Path(os.environ.get("LOCALAPPDATA", ".")) / "FocusProject"
            base.mkdir(parents=True, exist_ok=True)
            with open(base / "app.log", "a", encoding="utf-8") as f:
                f.write(f"{datetime.now().isoformat()} 托盘图标加载失败: {icon_file} {e}\n")
        except Exception:
            pass

    menu = pystray.Menu(
        pystray.MenuItem("打开窗口", on_open, default=True),
        pystray.MenuItem("退出", on_exit),
    )

    tray = pystray.Icon("篆香", image, "篆香", menu)
    return tray