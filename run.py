"""一键启动：Web 服务 + 桌面监控助手。"""
import uvicorn

from app.monitor import start_monitor


def main():
    start_monitor()
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
