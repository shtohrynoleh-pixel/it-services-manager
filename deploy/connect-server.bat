@echo off
title IT Forge - Server Management
color 0A
echo.
echo  ==========================================
echo   IT Forge - Server Management
echo  ==========================================
echo.
echo  Server: 54.161.122.55
echo  App:    https://itforge.app
echo.
echo  ==========================================
echo   COMMANDS:
echo  ==========================================
echo.
echo   [1] Connect to server (SSH)
echo   [2] DEPLOY (push + update + restart)
echo   [3] View server logs
echo   [4] Restart app
echo   [5] Server status
echo   [6] Push to GitHub only
echo   [7] Pull on server only
echo   [8] Restart local app
echo   [9] Force deploy
echo   [10] Switch to PostgreSQL
echo   [11] Switch to SQLite
echo   [12] Check which database
echo.
echo  ==========================================
echo.

set KEY=F:\Projects\it-services-manager\it_services.pem
set SERVER=ec2-user@54.161.122.55
set PROJECT=F:\Projects\it-services-manager

:menu
echo.
set /p choice="Enter number (1-12) or Q to quit: "

if "%choice%"=="1" goto connect
if "%choice%"=="2" goto deploy
if "%choice%"=="3" goto logs
if "%choice%"=="4" goto restart
if "%choice%"=="5" goto status
if "%choice%"=="6" goto pushonly
if "%choice%"=="7" goto pullonly
if "%choice%"=="8" goto localrestart
if "%choice%"=="9" goto forcedeploy
if "%choice%"=="10" goto switchpg
if "%choice%"=="11" goto switchsqlite
if "%choice%"=="12" goto checkdb
if /i "%choice%"=="q" goto end
echo Invalid choice.
goto menu

:connect
echo.
echo Connecting to server...
ssh -i "%KEY%" %SERVER%
goto menu

:deploy
echo.
echo === DEPLOY ===
cd /d %PROJECT%
echo Changed files:
git status --short
echo.
set /p msg="Commit message (Enter for 'Update'): "
if "%msg%"=="" set msg=Update
echo.
echo [1/3] Pushing to GitHub...
git add -A
git commit -m "%msg%"
git push origin main
echo.
echo [2/3] Updating server...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && git stash 2>/dev/null; git pull origin main && npm install --production 2>&1 | tail -3 && pm2 restart itm 2>/dev/null || pm2 start server.js --name itm && pm2 save"
echo.
echo [3/3] Done!
ssh -i "%KEY%" %SERVER% "pm2 status"
echo.
echo  App: https://itforge.app
goto menu

:logs
echo.
ssh -i "%KEY%" %SERVER% "pm2 logs itm --lines 40"
goto menu

:restart
echo.
ssh -i "%KEY%" %SERVER% "cd /opt/itm && pm2 restart itm 2>/dev/null || pm2 start server.js --name itm && pm2 save && pm2 status"
goto menu

:status
echo.
ssh -i "%KEY%" %SERVER% "echo '=== APP ===' && pm2 status && echo '' && echo '=== DB ===' && head -1 /opt/itm/.env 2>/dev/null; grep DATABASE_URL /opt/itm/.env 2>/dev/null || echo 'SQLite (no DATABASE_URL)' && echo '' && echo '=== DISK ===' && df -h / && echo '' && echo '=== MEMORY ===' && free -h"
goto menu

:pushonly
echo.
cd /d %PROJECT%
set /p msg="Commit message (Enter for 'Update'): "
if "%msg%"=="" set msg=Update
git add -A
git commit -m "%msg%"
git push origin main
echo Pushed!
goto menu

:pullonly
echo.
ssh -i "%KEY%" %SERVER% "cd /opt/itm && git stash 2>/dev/null; git pull origin main && npm install --production 2>&1 | tail -3 && pm2 restart itm 2>/dev/null || pm2 start server.js --name itm && pm2 save && pm2 status"
goto menu

:localrestart
echo.
cd /d %PROJECT%
taskkill /f /im node.exe 2>nul
start "ITForge Local" cmd /c "cd /d %PROJECT% && node server.js"
echo Local app started at http://localhost:3000
goto menu

:forcedeploy
echo.
echo === FORCE DEPLOY ===
cd /d %PROJECT%
set /p msg="Commit message (Enter for 'Force update'): "
if "%msg%"=="" set msg=Force update
echo [1/3] Force pushing...
git add -A
git commit -m "%msg%"
git push origin main --force
echo [2/3] Force updating server (keeping DB + .env)...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && cp db/app.db /tmp/itm-backup.db 2>/dev/null; cp .env /tmp/itm-backup.env 2>/dev/null; git fetch origin && git reset --hard origin/main && cp /tmp/itm-backup.db db/app.db 2>/dev/null; cp /tmp/itm-backup.env .env 2>/dev/null; npm install --production 2>&1 | tail -3 && pm2 restart itm 2>/dev/null || pm2 start server.js --name itm && pm2 save"
echo [3/3] Done!
ssh -i "%KEY%" %SERVER% "pm2 status"
goto menu

:switchpg
echo.
echo ==========================================
echo   SWITCH TO POSTGRESQL
echo ==========================================
echo.
echo This will:
echo   1. Install PostgreSQL on the server
echo   2. Create database and user
echo   3. Run the schema
echo   4. Install Node packages (pg, deasync)
echo   5. Set DATABASE_URL in .env
echo   6. Restart the app
echo.
set /p pgpass="Enter PostgreSQL password for 'itforge' user: "
if "%pgpass%"=="" (
  echo Password required!
  goto menu
)
echo.
echo Installing PostgreSQL and setting up...
ssh -i "%KEY%" %SERVER% "sudo dnf install -y postgresql15-server postgresql15 2>/dev/null || sudo amazon-linux-extras install postgresql15 2>/dev/null || sudo dnf install -y postgresql-server postgresql 2>/dev/null && sudo postgresql-setup --initdb 2>/dev/null; sudo systemctl enable postgresql && sudo systemctl start postgresql && echo 'PostgreSQL installed and started'"
echo.
echo Creating database...
ssh -i "%KEY%" %SERVER% "sudo -u postgres psql -c \"CREATE USER itforge WITH PASSWORD '%pgpass%';\" 2>/dev/null; sudo -u postgres psql -c \"CREATE DATABASE itforge OWNER itforge;\" 2>/dev/null; sudo -u postgres psql -c \"GRANT ALL PRIVILEGES ON DATABASE itforge TO itforge;\" 2>/dev/null && echo 'Database created'"
echo.
echo Configuring auth...
ssh -i "%KEY%" %SERVER% "sudo sed -i 's/peer/md5/g; s/ident/md5/g' /var/lib/pgsql/data/pg_hba.conf 2>/dev/null; sudo sed -i 's/peer/md5/g; s/ident/md5/g' /var/lib/pgsql15/data/pg_hba.conf 2>/dev/null; sudo systemctl restart postgresql && echo 'Auth configured'"
echo.
echo Running schema...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && PGPASSWORD=%pgpass% psql -U itforge -d itforge -h localhost -f db/postgres-schema.sql && echo 'Schema created'"
echo.
echo Installing Node packages...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && npm install pg deasync --save 2>&1 | tail -3"
echo.
echo Setting DATABASE_URL...
ssh -i "%KEY%" %SERVER% "grep -q DATABASE_URL /opt/itm/.env && sed -i 's|^DATABASE_URL=.*|DATABASE_URL=postgresql://itforge:%pgpass%@localhost:5432/itforge|' /opt/itm/.env || echo 'DATABASE_URL=postgresql://itforge:%pgpass%@localhost:5432/itforge' >> /opt/itm/.env && echo 'DATABASE_URL set'"
echo.
echo Restarting app...
ssh -i "%KEY%" %SERVER% "cd /opt/itm && pm2 restart itm && sleep 2 && pm2 logs itm --lines 5 --nostream"
echo.
echo ==========================================
echo   PostgreSQL setup complete!
echo   Check logs above for confirmation.
echo ==========================================
goto menu

:switchsqlite
echo.
echo Switching back to SQLite...
ssh -i "%KEY%" %SERVER% "sed -i '/^DATABASE_URL/d' /opt/itm/.env && echo 'DATABASE_URL removed' && cd /opt/itm && pm2 restart itm && sleep 2 && pm2 logs itm --lines 5 --nostream"
echo.
echo Switched to SQLite!
goto menu

:checkdb
echo.
echo Checking database...
ssh -i "%KEY%" %SERVER% "grep DATABASE_URL /opt/itm/.env 2>/dev/null && echo '==> PostgreSQL' || echo '==> SQLite (no DATABASE_URL in .env)'; echo ''; cd /opt/itm && pm2 logs itm --lines 3 --nostream 2>/dev/null"
goto menu

:end
echo Goodbye!
exit
