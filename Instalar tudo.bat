@echo off
chcp 65001 >nul
title Pedro Agent - instalar tudo
cd /d "%~dp0"
if not exist "%~dp0app\index.html" goto semarquivos
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\instalar.ps1"
exit /b
:semarquivos
echo ERRO: arquivos do aplicativo nao encontrados ao lado deste .bat.
echo Extraia o ZIP primeiro: botao direito no ZIP, "Extrair tudo".
pause
