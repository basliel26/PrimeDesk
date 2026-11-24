@echo off
title PrimeDesk Launcher
echo Starting PrimeDesk Services...
start "PrimeDesk Signaling Server" cmd /c "node src/server/signaling.js"
timeout /t 2 /nobreak >nul
start "PrimeDesk App" cmd /c "npx electron ."
echo PrimeDesk launched successfully!
