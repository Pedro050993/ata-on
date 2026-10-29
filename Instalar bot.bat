@echo off
chcp 65001 >nul
title Pedro Agent - instalar bot
cd /d "%~dp0bot"
where node >nul 2>nul
if errorlevel 1 goto semnode
echo Instalando o Playwright - automacao do navegador do bot...
call npm install
if errorlevel 1 goto falha
echo Baixando o navegador Chromium do bot, cerca de 170 MB...
call npx playwright install chromium
if errorlevel 1 goto falha
echo.
echo Pronto. Abra o "Iniciar Pedro Agent.bat".
pause
exit /b
:semnode
echo Instale primeiro o Node.js LTS, gratuito: https://nodejs.org
pause
exit /b 1
:falha
echo Falhou. Veja a mensagem acima.
pause
exit /b 1
