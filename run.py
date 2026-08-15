"""一键启动：Web 服务 + 桌面监控助手（EXE 版随机端口并自动开浏览器）。"""
import os
import socket
import sys
import threading
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


def main():
    _log("启动开始")
    port = _find_free_port()
    host = "127.0.0.1" if getattr(sys, "frozen", False) else "0.0.0.0"
    _log(f"端口 {port} host {host}")
    if os.environ.get("FOCUS_NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    _log("准备启动 uvicorn")
    start_monitor()
    # EXE 无控制台窗口时 stderr 无效，uvicorn 默认日志会卡启动；仅 EXE 模式关掉其日志配置
    _log_config = None if getattr(sys, "frozen", False) else uvicorn.config.LOGGING_CONFIG
    uvicorn.run(app, host=host, port=port, log_config=_log_config)
    _log("uvicorn 已退出")


if __name__ == "__main__":
    main()
