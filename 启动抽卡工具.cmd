@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo 请先按照 README.md 创建虚拟环境并安装依赖。
  pause
  exit /b 1
)
".venv\Scripts\python.exe" scripts\check_environment.py
if errorlevel 1 (
  pause
  exit /b 1
)
".venv\Scripts\python.exe" tools\gacha_rating_app\launch.py
if errorlevel 1 pause
