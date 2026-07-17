@echo off
chcp 65001 >nul
rem ===== 簽到退系統一鍵啟動：同時開啟系統與 ngrok =====
rem 使用方式：
rem   1. 在 .env 加一行 NGROK_DOMAIN=您的網域.ngrok-free.app
rem   2. 雙擊本檔即可同時啟動系統與 ngrok
rem   3. 要開機自動啟動：按 Win+R 輸入 shell:startup，把本檔的捷徑放進去

cd /d %~dp0

set NGROK_DOMAIN=
if exist .env (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="NGROK_DOMAIN" set NGROK_DOMAIN=%%b
  )
)

start "簽到退系統" cmd /k npm start

if defined NGROK_DOMAIN (
  start "ngrok 公開網址" cmd /k ngrok http --url=%NGROK_DOMAIN% 3000
) else (
  echo [提示] .env 未設定 NGROK_DOMAIN，只啟動了系統（本機 http://localhost:3000）。
  echo         若需公開網址，請在 .env 加入：NGROK_DOMAIN=您的網域.ngrok-free.app
  pause
)
