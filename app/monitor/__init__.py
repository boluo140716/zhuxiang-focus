"""桌面监控助手（Windows 前台窗口轮询）。"""
import threading


def start_monitor():
    """启动监控线程；非 Windows 或初始化失败时静默跳过。"""
    try:
        from app.monitor.win_monitor import MonitorLoop

        thread = threading.Thread(target=MonitorLoop().run, daemon=True)
        thread.start()
        return thread
    except Exception:
        return None
