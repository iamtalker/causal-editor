@echo off
chcp 65001 >nul
rem Node.js가 있으면 그대로 쓰고, 없으면 처음 한 번만 공식 사이트에서 내려받아 node 폴더에 둡니다.
if exist "%~dp0node\node.exe" goto start
where node >nul 2>&1
if not errorlevel 1 goto start
echo Node.js가 없어서 처음 한 번만 내려받습니다. (약 36MB, 공식 사이트 nodejs.org)
echo 잠시만 기다려 주세요...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0node-setup.ps1" -Root "%~dp0."
if errorlevel 1 (
  echo.
  echo Node.js를 내려받지 못했습니다. 인터넷 연결을 확인하거나 https://nodejs.org 에서 직접 설치해 주세요.
  pause
  exit /b 1
)
echo 준비되었습니다.
:start
for /d %%D in ("%~dp0*") do if exist "%%~fD\launch-hidden.vbs" wscript //nologo "%%~fD\launch-hidden.vbs"
