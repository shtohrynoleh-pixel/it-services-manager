# Creates a clean zip file for uploading to GitHub
# Run: right-click this file → "Run with PowerShell"
# Or: cd F:\Projects\it-services-manager\deploy; .\make-zip.ps1

$src = "F:\Projects\it-services-manager"
$dest = "F:\Projects\itm-for-github"
$zip = "F:\Projects\itm-for-github.zip"

Write-Host ""
Write-Host "Creating clean package for GitHub..." -ForegroundColor Cyan
Write-Host ""

# Clean up previous
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }

# Create temp folder
New-Item -ItemType Directory -Path $dest | Out-Null

# Copy everything except node_modules, .git, uploads, backups
$exclude = @('node_modules', '.git', 'uploads', 'backups')
Get-ChildItem $src -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
    if ($_.PSIsContainer) {
        Copy-Item $_.FullName -Destination (Join-Path $dest $_.Name) -Recurse
    } else {
        if ($_.Name -ne '.env') {
            Copy-Item $_.FullName -Destination (Join-Path $dest $_.Name)
        }
    }
}

# Remove database files but keep schema.js
Remove-Item (Join-Path $dest "db\app.db") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dest "db\app.db-wal") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dest "db\app.db-shm") -ErrorAction SilentlyContinue

# Create zip
Compress-Archive -Path (Join-Path $dest "*") -DestinationPath $zip -Force

# Count files
$count = (Get-ChildItem $dest -Recurse -File).Count
$size = [math]::Round((Get-Item $zip).Length / 1MB, 2)

# Clean up temp folder
Remove-Item $dest -Recurse -Force

Write-Host "Done!" -ForegroundColor Green
Write-Host ""
Write-Host "  Zip file: $zip" -ForegroundColor White
Write-Host "  Files:    $count" -ForegroundColor White
Write-Host "  Size:     $size MB" -ForegroundColor White
Write-Host ""
Write-Host "Now:" -ForegroundColor Yellow
Write-Host "  1. Go to https://github.com/shtohrynoleh-pixel/it-services-manager"
Write-Host "  2. Click 'Add file' -> 'Upload files'"
Write-Host "  3. UNZIP the file first, then drag the CONTENTS into GitHub"
Write-Host "     (GitHub doesn't accept .zip files directly)"
Write-Host ""
Write-Host "Or just drag the folder: F:\Projects\itm-for-github" -ForegroundColor Cyan
Write-Host ""

# Also create unzipped folder for easy drag-and-drop
$dragFolder = "F:\Projects\itm-ready-to-upload"
if (Test-Path $dragFolder) { Remove-Item $dragFolder -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $dragFolder

Write-Host "Ready-to-upload folder: $dragFolder" -ForegroundColor Green
Write-Host "  -> Open this folder and drag ALL contents into GitHub" -ForegroundColor White
Write-Host ""

# Open the folder
Start-Process explorer.exe $dragFolder

Read-Host "Press Enter to close"
