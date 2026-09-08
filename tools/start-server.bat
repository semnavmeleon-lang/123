@echo off
cd /d "%~dp0.."
echo Запуск локального сервера для надстройки Outlook...
echo Оставьте это окно открытым, пока пользуетесь надстройкой.
echo Закрыть окно = остановить сервер.
echo.
python tools\serve.py
pause
