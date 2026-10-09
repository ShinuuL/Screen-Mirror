@echo off
rem Abre o painel do Screen Mirror numa janela propria. Feche esta janela para encerrar.
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install || (pause & exit /b 1)
)
node src\cli.ts serve --open
pause
