@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 인과 편집기를 시작합니다...
start "" http://localhost:8787
node server.js
pause
