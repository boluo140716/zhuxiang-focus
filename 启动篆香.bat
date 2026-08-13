@echo off
cd /d "%~dp0"

set "PYCMD="
set "PYARGS="
if exist "%~dp0.venv\Scripts\python.exe" set "PYCMD=%~dp0.venv\Scripts\python.exe"
if "%PYCMD%"=="" if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PYCMD=%LOCALAPPDATA%\Python\bin\python.exe"
if "%PYCMD%"=="" (
    where python >nul 2>nul
    if not errorlevel 1 set "PYCMD=python"
)
if "%PYCMD%"=="" (
    where py >nul 2>nul
    if not errorlevel 1 (
        set "PYCMD=py"
        set "PYARGS=-3"
    )
)
if "%PYCMD%"=="" (
    echo 未找到 Python，请安装 Python 3 后重试。
    pause
    exit /b 1
)
echo ============================================
echo   「篆香」专注训练营 正在启动...
echo   启动后请保持本窗口开启（可最小化）
echo   浏览器访问: http://127.0.0.1:8000
echo ============================================
"%PYCMD%" %PYARGS% run.py
echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul