@echo off
chcp 65001 >nul
set "PYTHON=C:\Users\owen\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
start "Backend" /d "C:\Users\owen\第一届黑客松\src\backend" cmd /k "%PYTHON% -m uvicorn main:app --host 0.0.0.0 --port 8000"
start "Frontend" /d "C:\Users\owen\第一届黑客松\src\frontend" cmd /k "npm run dev"
pause
