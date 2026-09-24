param([switch]$Launch)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'phwgna-setup-core.ps1')

$packageRoot = Split-Path -Parent $PSScriptRoot
$browser = @(Find-PhwgnaBrowsers) | Where-Object { $_.id -eq 'chrome' } | Select-Object -First 1
if (-not $browser) { throw 'Không tìm thấy Google Chrome trên máy này.' }
$stateRoot = Join-Path $env:LOCALAPPDATA 'phwgna-stv-chrome-max'
$installed = Install-PhwgnaExtension -SourceDirectory $packageRoot -DestinationRoot $stateRoot
$result = New-PhwgnaDedicatedChromeShortcut -Browser $browser -ExtensionDirectory $installed.path -StateRoot $stateRoot
Write-Host "Đã tạo Chrome riêng cho STV: $($result.path)"
Write-Host "Hồ sơ riêng: $($result.profile)"
Write-Host 'Lần đầu hãy đăng nhập Gemini trong cửa sổ Chrome này; các lần sau hồ sơ sẽ được giữ lại.'
if ($Launch) { Start-Process -FilePath $result.path }
