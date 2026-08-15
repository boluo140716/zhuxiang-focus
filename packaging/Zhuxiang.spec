# -*- mode: python ; coding: utf-8 -*-
"""篆香 EXE 打包配置（PyInstaller onedir）。"""
from PyInstaller.utils.hooks import collect_all

ROOT = r"D:\Focus_Project"

datas = [(ROOT + r"\static", "static")]
binaries = []
hiddenimports = []

# uvicorn / winotify / winsdk / webview / pystray：动态导入与数据文件收集
for pkg in ("uvicorn", "winotify", "winsdk", "webview", "pystray"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

hiddenimports += [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    "webview.platforms.winforms",
    "clr",
]

a = Analysis(
    [ROOT + r"\run.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["pytest", "pytest_xdist", "test", "tests"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Zhuxiang",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon=ROOT + r"\packaging\icon.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Zhuxiang",
)
