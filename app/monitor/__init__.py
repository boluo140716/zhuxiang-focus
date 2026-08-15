"""桌面监控助手（Windows 前台窗口轮询）。"""
import threading


def start_monitor(api_base="http://127.0.0.1:8000"):
    """启动监控线程；非 Windows 或初始化失败时静默跳过。api_base 需与后端实际端口一致。"""
    try:
        from app.monitor.win_monitor import MonitorLoop

        thread = threading.Thread(target=MonitorLoop(api_base=api_base).run, daemon=True)
        thread.start()
        return thread
    except Exception:
        return None
