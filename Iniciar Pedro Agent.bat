@echo off
chcp 65001 >nul
title Pedro Agent
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  echo Iniciando o servidor local do Pedro Agent...
  echo Mantenha esta janela aberta enquanto usa o app. Para sair, feche-a.
  node bot\server.js --abrir
) else (
  echo Node.js nao encontrado. Usando o servidor simples do Windows (sem o bot participante).
  echo Para usar o bot, instale o Node.js LTS em https://nodejs.org e rode "Instalar bot.bat".
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\servidor.ps1"
)
pause
