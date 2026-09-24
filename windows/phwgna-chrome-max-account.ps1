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
    $launchState = Get-PhwgnaChromeLaunchState -UserDataRoot $userDataRoot -ExtensionDirectory $installed.path
    if ($launchState -eq 'max_running') {
        $openArguments = '--profile-directory="' + $profile + '" --new-tab "' + $StartUrl + '"'
        Start-Process -FilePath $browser.path -ArgumentList $openArguments
        exit 0
    }
    if ($launchState -eq 'browser_running') {
        Add-Type -AssemblyName PresentationFramework
        [void][System.Windows.MessageBox]::Show(
            'Chrome thường đang mở. Hãy đóng hoàn toàn Chrome rồi mở lại Chrome Max Tài Khoản.',
            'Phwgna STV',
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Information
        )
        exit 2
    }
    $arguments = Get-PhwgnaDedicatedChromeArguments -ProfileRoot $userDataRoot -ProfileDirectory $profile -ExtensionDirectory $installed.path -StartUrl $StartUrl
    Start-Process -FilePath $browser.path -ArgumentList $arguments
}
