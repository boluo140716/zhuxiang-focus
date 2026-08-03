"""FastAPI 入口。"""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.db import init_db
from app.routers import distractions, sessions, settings, stats

init_db()

app = FastAPI(title="FocusDojo 专注训练营")
app.include_router(sessions.router)
app.include_router(distractions.router)
app.include_router(settings.router)
app.include_router(stats.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


app.mount("/", StaticFiles(directory="static", html=True), name="static")
