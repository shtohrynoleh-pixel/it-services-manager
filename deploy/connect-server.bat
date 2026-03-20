@echo off
title IT Services Manager - Server Connection
color 0A
echo.
echo  ==========================================
echo   IT Services Manager - Server Commands
echo  ==========================================
echo.
echo  Server IP: 54.161.122.55
echo  App URL:   http://54.161.122.55:3000
echo  Login:     admin / admin
echo.
echo  ==========================================
echo   COMMANDS:
echo  ==========================================
echo.
echo   [1] Connect to server (SSH terminal)
echo   [2] DEPLOY (push to GitHub + update server + restart)
echo   [3] View server logs
echo   [4] Restart app on server
echo   [5] Check server status
echo   [6] Quick push to GitHub only
echo   [7] Quick update server only (git pull + restart)
echo   [8] Restart local app
echo   [9] Force deploy (force push + hard reset server)
echo.
echo  ==========================================
echo.

set KEY=F:\Projects\it-services-manager\it_services.pem
set SERVER=ec2-user@54.161.122.55
set PROJECT=F:\Projects\it-services-manager

:menu
echo.
set /p choice="Enter number (1-9) or Q to quit: "

if "%choice%"=="1" goto connect
if "%choice%"=="2" goto deploy
if "%choice%"=="3" goto logs
if "%choice%"=="4" goto restart
if "%choice%"=="5" goto status
if "%choice%"=="6" goto pushonly
if "%choice%"=="7" goto pullonly
if "%choice%"=="8" goto localrestart
if "%choice%"=="9" goto forcedeploy
if /i "%choice%"=="q" goto end
echo Invalid choice. Try again.
goto menu

:connect
echo.
echo Connecting to server... (type "exit" to come back)
echo.
ssh -i "%KEY%" %SERVER%
goto menu

:deploy
echo.
echo ==========================================
echo   FULL DEPLOY
echo ==========================================
echo.
cd /d %PROJECT%
echo [1/4] Checking changes...
git status --short
echo.
set /p msg="Commit message (or press Enter for 'Update'): "
if "%msg%"=="" set msg=Update
echo.
echo [2/4] Committing and pushing to GitHub...
git add -A
git commit -m "%msg%"
git push origin main
echo.
echo [3/4] Updating server...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && git pull origin main && npm install --production 2>&1 | tail -3 && pm2 restart itm 2>/dev/null || pm2 start server.js --name itm && pm2 save"
echo.
echo [4/4] Verifying...
ssh -i "%KEY%" %SERVER% "pm2 status"
echo.
echo ==========================================
echo   Deploy complete!
echo   App: http://54.161.122.55:3000
echo ==========================================
goto menu

:logs
echo.
echo Showing last 50 lines of logs (Ctrl+C to stop)...
echo.
ssh -i "%KEY%" %SERVER% "pm2 logs itm --lines 50"
goto menu

:restart
echo.
echo Restarting app on server...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && pm2 restart itm 2>/dev/null || pm2 start server.js --name itm && pm2 save && pm2 status"
echo.
goto menu

:status
echo.
echo Checking server status...
ssh -i "%KEY%" %SERVER% "echo '=== APP ===' && pm2 status && echo '' && echo '=== DISK ===' && df -h / && echo '' && echo '=== MEMORY ===' && free -h"
echo.
goto menu

:pushonly
echo.
cd /d %PROJECT%
echo Changed files:
git status --short
echo.
set /p msg="Commit message (or press Enter for 'Update'): "
if "%msg%"=="" set msg=Update
git add -A
git commit -m "%msg%"
git push origin main
echo.
echo Pushed to GitHub!
goto menu

:pullonly
echo.
echo Pulling latest code and restarting server...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && git pull origin main && npm install --production 2>&1 | tail -3 && pm2 restart itm 2>/dev/null || pm2 start server.js --name itm && pm2 save && pm2 status"
echo.
goto menu

:localrestart
echo.
echo Restarting local app...
cd /d %PROJECT%
taskkill /f /im node.exe 2>nul
echo Starting server...
start "ITM Local" cmd /c "cd /d %PROJECT% && node server.js"
echo.
echo Local app restarted at http://localhost:3000
goto menu

:forcedeploy
echo.
echo ==========================================
echo   FORCE DEPLOY (overwrites server)
echo ==========================================
echo.
cd /d %PROJECT%
set /p msg="Commit message (or press Enter for 'Force update'): "
if "%msg%"=="" set msg=Force update
echo.
echo [1/3] Force pushing to GitHub...
git add -A
git commit -m "%msg%"
git push origin main --force
echo.
echo [2/3] Force updating server...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && git fetch origin && git reset --hard origin/main && npm install --production 2>&1 | tail -3 && pm2 restart itm 2>/dev/null || pm2 start server.js --name itm && pm2 save"
echo.
echo [3/3] Verifying...
ssh -i "%KEY%" %SERVER% "pm2 status"
echo.
echo ==========================================
echo   Force deploy complete!
echo   App: http://54.161.122.55:3000
echo ==========================================
goto menu

:end
echo Goodbye!
exit
