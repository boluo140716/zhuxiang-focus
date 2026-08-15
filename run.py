"""一键启动：Web 服务 + 桌面监控助手。

开发模式：命令行 + 浏览器打开。
EXE 模式：pywebview 桌面窗口（系统 WebView2），关窗即退出后端。
"""
import os
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime
from pathlib import Path

import uvicorn

from app.main import app
from app.monitor import start_monitor


def _log(msg: str) -> None:
    """启动日志（EXE 无控制台，排障用；写不进时静默）。"""
    try:
        base = Path(os.environ.get("LOCALAPPDATA", ".")) / "FocusProject"
        base.mkdir(parents=True, exist_ok=True)
        with open(base / "app.log", "a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat()} {msg}\n")
    except Exception:
        pass


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_port(port: int, timeout: float = 25.0) -> None:
    """等待服务端口可连（窗口加载前确保后端就绪）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    _log(f"等待端口 {port} 超时")


def _run_desktop(port: int) -> None:
    """EXE 模式：uvicorn 跑后台线程，pywebview 桌面窗口 + 系统托盘。"""
    import webview
    from app.tray import create_tray

    def serve():
        # windowed 下 stderr 无效，uvicorn 默认日志会卡启动，故 log_config=None
        uvicorn.run(app, host="127.0.0.1", port=port, log_config=None)

    threading.Thread(target=serve, daemon=True).start()
    _wait_port(port)
    _log("后端就绪，打开桌面窗口")
    window = webview.create_window(
        "篆香",
        f"http://127.0.0.1:{port}",
        width=1280,
        height=860,
        min_size=(1024, 700),
    )

    # 托盘：关窗后隐藏窗口，托盘接管；"退出"才真正退出
    tray = create_tray(
        on_open=lambda: window.show(),
        on_exit=lambda: (window.destroy(), os._exit(0)),
    )
    tray_started = False

    def on_closing():
        """窗口关闭回调：隐藏窗口 + 启动托盘。"""
        nonlocal tray_started
        window.hide()
        if not tray_started:
            tray_started = True
            threading.Thread(target=tray.run, daemon=True).start()
        return False  # 阻止默认关闭行为

    window.events.closing += on_closing
    webview.start()
    _log("窗口已关闭，退出进程")
    os._exit(0)


def _run_dev(port: int) -> None:
    """开发模式：命令行日志 + 自动开浏览器。"""
    if os.environ.get("FOCUS_NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    start_monitor()
    uvicorn.run(app, host="0.0.0.0", port=port, log_config=uvicorn.config.LOGGING_CONFIG)


def main():
    _log("启动开始")
    port = _find_free_port()
    _log(f"端口 {port} 模式 {'EXE' if getattr(sys, 'frozen', False) else 'dev'}")
    if getattr(sys, "frozen", False):
        _run_desktop(port)
    else:
        _run_dev(port)


if __name__ == "__main__":
    main()
