@echo off
chcp 65001 >nul
for /d %%D in ("%~dp0*") do if exist "%%~fD\server.js" cd /d "%%~fD"
node server.js
