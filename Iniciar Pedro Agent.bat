@echo off
chcp 65001 >nul
title Pedro Agent
cd /d "%~dp0"

if not exist "%~dp0app\index.html" goto semarquivos

where node >nul 2>nul
if errorlevel 1 goto semnode

echo Iniciando o servidor local do Pedro Agent...
echo Mantenha esta janela aberta enquanto usa o app. Para sair, feche esta janela.
echo.
node "%~dp0bot\server.js" --abrir
echo.
echo O servidor parou. Se houve erro, ele aparece acima.
pause
exit /b

:semnode
echo Node.js nao encontrado - usando o servidor simples do Windows, sem o bot participante.
echo Para usar o bot, instale o Node.js LTS em https://nodejs.org e rode "Instalar bot.bat".
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\servidor.ps1"
echo.
echo O servidor parou. Se houve erro, ele aparece acima.
pause
exit /b

:semarquivos
echo ERRO: arquivos do aplicativo nao encontrados ao lado deste .bat.
echo Provavel causa: o .bat foi aberto de dentro do ZIP.
echo Clique com o botao direito no ZIP, escolha "Extrair tudo" e rode o .bat da pasta extraida.
echo Pasta atual: %~dp0
pause
