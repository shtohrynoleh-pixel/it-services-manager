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
echo   [2] Update server (git pull + restart)
echo   [3] View server logs
echo   [4] Restart app on server
echo   [5] Push local changes to GitHub
echo   [6] Full deploy (push + pull + restart)
echo   [7] Upload files directly (skip GitHub)
echo   [8] Check server status
echo   [9] Restart local app
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
if "%choice%"=="2" goto update
if "%choice%"=="3" goto logs
if "%choice%"=="4" goto restart
if "%choice%"=="5" goto push
if "%choice%"=="6" goto fulldeploy
if "%choice%"=="7" goto directupload
if "%choice%"=="8" goto status
if "%choice%"=="9" goto localrestart
if /i "%choice%"=="q" goto end
echo Invalid choice. Try again.
goto menu

:connect
echo.
echo Connecting to server...
echo Type "exit" to come back to this menu.
echo.
ssh -i "%KEY%" %SERVER%
goto menu

:update
echo.
echo Pulling latest code and restarting...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && git pull && npm install --production && pm2 restart itm && echo. && echo === APP RESTARTED === && pm2 status"
echo.
echo Done!
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
ssh -i "%KEY%" %SERVER% "pm2 restart itm && echo. && echo === APP RESTARTED === && pm2 status"
echo.
goto menu

:push
echo.
echo Pushing local changes to GitHub...
cd /d %PROJECT%
echo.
echo Changed files:
git status --short
echo.
set /p msg="Commit message: "
git add -A
git commit -m "%msg%"
git push
echo.
echo Pushed to GitHub!
goto menu

:fulldeploy
echo.
echo === FULL DEPLOY: Push to GitHub + Update Server ===
echo.
cd /d %PROJECT%
echo Changed files:
git status --short
echo.
set /p msg="Commit message: "
echo.
echo [1/3] Committing...
git add -A
git commit -m "%msg%"
echo.
echo [2/3] Pushing to GitHub...
git push
echo.
echo [3/3] Updating server and restarting...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && git pull && npm install --production && pm2 restart itm && echo. && echo === APP RESTARTED === && pm2 status"
echo.
echo ==========================================
echo   Deploy complete!
echo   App: http://54.161.122.55:3000
echo ==========================================
goto menu

:directupload
echo.
echo === DIRECT UPLOAD (skip GitHub) ===
echo.
echo Creating package...
cd /d %PROJECT%

REM Create zip excluding node_modules, .git, db files, .env
powershell -Command "if(Test-Path $env:TEMP\itm-upload.zip){Remove-Item $env:TEMP\itm-upload.zip}; $files=Get-ChildItem '%PROJECT%' -Exclude node_modules,.git,uploads,backups; $tmp=\"$env:TEMP\itm-stage\"; if(Test-Path $tmp){Remove-Item $tmp -Recurse -Force}; New-Item -ItemType Directory $tmp|Out-Null; $files|ForEach-Object{if($_.Name -ne '.env'){Copy-Item $_.FullName -Destination $tmp\$($_.Name) -Recurse}}; Remove-Item $tmp\db\app.db*  -ErrorAction SilentlyContinue; Compress-Archive -Path $tmp\* -DestinationPath $env:TEMP\itm-upload.zip -Force; Remove-Item $tmp -Recurse -Force; Write-Host 'Package created.'"

echo Uploading to server...
scp -i "%KEY%" "%TEMP%\itm-upload.zip" %SERVER%:~/itm-upload.zip

echo Extracting and restarting on server...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && unzip -o ~/itm-upload.zip && npm install --production && pm2 restart itm && rm ~/itm-upload.zip && echo. && echo === APP RESTARTED === && pm2 status"
echo.
echo ==========================================
echo   Direct upload complete!
echo   App: http://54.161.122.55:3000
echo ==========================================
goto menu

:status
echo.
echo Checking server status...
ssh -i "%KEY%" %SERVER% "echo '=== PM2 ===' && pm2 status && echo '' && echo '=== Disk ===' && df -h / && echo '' && echo '=== Memory ===' && free -h && echo '' && echo '=== Uptime ===' && uptime"
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

:end
echo Goodbye!
exit
