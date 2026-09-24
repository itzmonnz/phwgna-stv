param([switch]$Launch, [switch]$RefreshProfile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'phwgna-setup-core.ps1')

$packageRoot = Split-Path -Parent $PSScriptRoot
$browser = @(Find-PhwgnaBrowsers) | Where-Object { $_.id -eq 'chrome' } | Select-Object -First 1
if (-not $browser) { throw 'Không tìm thấy Google Chrome trên máy này.' }
$sourceRoot = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$stateRoot = Join-Path $env:LOCALAPPDATA 'phwgna-stv-chrome-max'
$cloneRoot = Join-Path $stateRoot 'cloned-user-data'
$installed = Install-PhwgnaExtension -SourceDirectory $packageRoot -DestinationRoot $stateRoot

if ($RefreshProfile -or -not (Test-Path -LiteralPath $cloneRoot -PathType Container)) {
    Write-Host 'Đang sao chép tài khoản và phiên đăng nhập Chrome. Không mở Chrome trong lúc này...'
    $clone = Copy-PhwgnaChromeUserData -SourceRoot $sourceRoot -DestinationRoot $cloneRoot
    Write-Host "Đã sao chép $($clone.profileCount) hồ sơ Chrome."
    if ($clone.backup) { Write-Host "Bản clone cũ được giữ tại: $($clone.backup)" }
}

$result = New-PhwgnaClonedChromeShortcut -Browser $browser -ExtensionDirectory $installed.path -ProfileRoot $cloneRoot
Write-Host "Đã tạo Chrome STV dùng tài khoản đã đăng nhập: $($result.path)"
Write-Host "Hồ sơ clone: $($result.profile)"
Write-Host 'Chrome cá nhân gốc không bị thay đổi. Nếu Google vô hiệu hóa phiên cũ, chỉ tài khoản đó mới cần đăng nhập lại.'
if ($Launch) { Start-Process -FilePath $result.path }
