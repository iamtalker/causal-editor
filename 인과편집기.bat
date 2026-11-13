@echo off
chcp 65001 >nul
for /d %%D in ("%~dp0*") do if exist "%%~fD\launch-hidden.vbs" wscript //nologo "%%~fD\launch-hidden.vbs"
