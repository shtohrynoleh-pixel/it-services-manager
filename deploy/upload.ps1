# ============================================
# Upload IT Services Manager to AWS EC2
# ============================================
#
# Usage:
#   .\deploy\upload.ps1 -KeyFile "C:\path\to\itm-key.pem" -ServerIP "1.2.3.4"
#
# First deploy:
#   .\deploy\upload.ps1 -KeyFile "C:\path\to\itm-key.pem" -ServerIP "1.2.3.4" -FirstTime
#

param(
    [Parameter(Mandatory=$true)]
    [string]$KeyFile,

    [Parameter(Mandatory=$true)]
    [string]$ServerIP,

    [switch]$FirstTime
)

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ZipFile = "$env:TEMP\itm.zip"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  IT Services Manager — Deploy to AWS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Package
Write-Host "[1/3] Packaging application..." -ForegroundColor Green

# Remove old zip
if (Test-Path $ZipFile) { Remove-Item $ZipFile }

# Create zip excluding node_modules, db files, .env, uploads
$TempDir = "$env:TEMP\itm-package"
if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
New-Item -ItemType Directory -Path $TempDir | Out-Null

# Copy files excluding unwanted dirs
Get-ChildItem $ProjectDir -Exclude @("node_modules", "uploads", ".git") | ForEach-Object {
    if ($_.PSIsContainer) {
        Copy-Item $_.FullName -Destination "$TempDir\$($_.Name)" -Recurse -Exclude @("app.db", "app.db-wal", "app.db-shm")
    } else {
        if ($_.Name -ne ".env") {
            Copy-Item $_.FullName -Destination "$TempDir\$($_.Name)"
        }
    }
}

Compress-Archive -Path "$TempDir\*" -DestinationPath $ZipFile -Force
Remove-Item $TempDir -Recurse -Force

$size = [math]::Round((Get-Item $ZipFile).Length / 1MB, 1)
Write-Host "  Package created: $size MB" -ForegroundColor Gray

# Step 2: Upload
Write-Host "[2/3] Uploading to $ServerIP..." -ForegroundColor Green
scp -i $KeyFile $ZipFile "ec2-user@${ServerIP}:~/itm.zip"

if ($LASTEXITCODE -ne 0) {
    Write-Host "  Upload failed! Check your key file and IP." -ForegroundColor Red
    exit 1
}

# Step 3: Deploy on server
Write-Host "[3/3] Deploying on server..." -ForegroundColor Green

if ($FirstTime) {
    # First time: upload setup script too
    $SetupScript = Join-Path $ProjectDir "deploy\setup.sh"
    scp -i $KeyFile $SetupScript "ec2-user@${ServerIP}:~/setup.sh"

    ssh -i $KeyFile "ec2-user@$ServerIP" @"
        sudo mkdir -p /opt/itm
        sudo chown ec2-user:ec2-user /opt/itm
        cd /opt/itm
        unzip -o ~/itm.zip
        chmod +x ~/setup.sh
        sudo bash ~/setup.sh
"@
} else {
    ssh -i $KeyFile "ec2-user@$ServerIP" @"
        cd /opt/itm
        unzip -o ~/itm.zip
        npm install --production 2>&1 | tail -3
        pm2 restart itm
        echo ''
        echo 'Deployed! App restarted.'
        pm2 status
"@
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Done! App is at: http://$ServerIP" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
