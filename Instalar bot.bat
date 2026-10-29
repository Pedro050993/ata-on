@echo off
chcp 65001 >nul
title Pedro Agent - instalar bot
cd /d "%~dp0bot"
where node >nul 2>nul
if not %errorlevel%==0 (
  echo Instale primeiro o Node.js LTS: https://nodejs.org  (gratuito^)
  pause
  exit /b 1
)
echo Instalando o Playwright (automacao do navegador do bot)...
call npm install
if not %errorlevel%==0 ( echo Falha no npm install. & pause & exit /b 1 )
echo Baixando o navegador Chromium do bot (~170 MB)...
call npx playwright install chromium
if not %errorlevel%==0 ( echo Falha ao baixar o Chromium. & pause & exit /b 1 )
echo.
echo Pronto. Abra o "Iniciar Pedro Agent.bat".
pause
