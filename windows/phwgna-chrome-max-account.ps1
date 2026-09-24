param([switch]$Launch, [switch]$LaunchOnly, [string]$StartUrl = 'https://sangtacviet.com/mybook/')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'phwgna-setup-core.ps1')

$packageRoot = Split-Path -Parent $PSScriptRoot
$browser = @(Find-PhwgnaBrowsers) | Where-Object { $_.id -eq 'chrome' } | Select-Object -First 1
if (-not $browser) { throw 'Không tìm thấy Google Chrome trên máy này.' }
$userDataRoot = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$stateRoot = Join-Path $env:LOCALAPPDATA 'phwgna-stv-chrome-max'
$installed = Install-PhwgnaExtension -SourceDirectory $packageRoot -DestinationRoot $stateRoot
$profile = Get-PhwgnaChromeProfileDirectory -UserDataRoot $userDataRoot

if (-not $LaunchOnly) {
    $result = New-PhwgnaAccountChromeShortcut -Browser $browser -LauncherScript $MyInvocation.MyCommand.Path -StartUrl $StartUrl
    Write-Host "Đã tạo Chrome STV dùng tài khoản hiện có: $($result.path)"
}

if ($Launch -or $LaunchOnly) {
    if (@(Get-Process -Name 'chrome' -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Hãy đóng hoàn toàn mọi cửa sổ Chrome rồi mở lại shortcut Chrome Max Tài Khoản.'
    }
    $arguments = Get-PhwgnaDedicatedChromeArguments -ProfileRoot $userDataRoot -ProfileDirectory $profile -ExtensionDirectory $installed.path -StartUrl $StartUrl
    Start-Process -FilePath $browser.path -ArgumentList $arguments
}
