@echo off
title CryptoResearch DEMO - fictional data - close this window to stop it
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. This folder pins Node 24 LTS through Volta ^(package.json^); Node 20 or newer also works. See README.md.
  pause
  exit /b 1
)
if not exist "dashboard\demo-workspace\workspace.json" node "dashboard\cli.js" demo build
node "dashboard\cli.js" serve --workspace "dashboard\demo-workspace" --open
if errorlevel 1 pause
