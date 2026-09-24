param([switch]$Launch, [switch]$LaunchOnly, [string]$StartUrl = 'https://sangtacviet.com/mybook/')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'phwgna-setup-core.ps1')

$packageRoot = Split-Path -Parent $PSScriptRoot
$browser = @(Find-PhwgnaBrowsers) | Where-Object { $_.id -eq 'chrome' } | Select-Object -First 1
if (-not $browser) { throw 'Không tìm thấy Google Chrome trên máy này.' }
$userDataRoot = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$stateRoot = Join-Path $env:LOCALAPPDATA 'phwgna-stv-chrome-max'
$installedPath = Join-Path $stateRoot 'extension'
$profile = Get-PhwgnaChromeProfileDirectory -UserDataRoot $userDataRoot

if (-not $LaunchOnly) {
    if (-not $Launch) {
        $installed = Install-PhwgnaExtension -SourceDirectory $packageRoot -DestinationRoot $stateRoot
    }
    $result = New-PhwgnaAccountChromeShortcut -Browser $browser -LauncherScript $MyInvocation.MyCommand.Path -StartUrl $StartUrl
    Write-Host "Đã tạo Chrome STV dùng tài khoản hiện có: $($result.path)"
}

if ($Launch -or $LaunchOnly) {
    $launchState = Get-PhwgnaChromeLaunchState -UserDataRoot $userDataRoot -ExtensionDirectory $installedPath
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
    $installed = Install-PhwgnaExtension -SourceDirectory $packageRoot -DestinationRoot $stateRoot
    $extensionSaved = Test-PhwgnaChromeExtensionInstalled -UserDataRoot $userDataRoot -ProfileDirectory $profile -ExtensionDirectory $installed.path
    if (-not $extensionSaved) {
        $setupArguments = '--profile-directory="' + $profile + '" --new-window "chrome://extensions/"'
        Start-Process -FilePath $browser.path -ArgumentList $setupArguments
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + (Join-Path $installed.path 'manifest.json') + '"')
        Add-Type -AssemblyName PresentationFramework
        [void][System.Windows.MessageBox]::Show(
            "Chrome chưa lưu extension STV.`n`n1. Bật Chế độ nhà phát triển.`n2. Chọn Tải tiện ích đã giải nén.`n3. Chọn thư mục:`n$($installed.path)`n`nCài xong, đóng Chrome rồi mở lại shortcut Chrome Max Tài Khoản.",
            'Cài extension Phwgna STV một lần',
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Information
        )
        exit 3
    }
    $arguments = Get-PhwgnaDedicatedChromeArguments -ProfileRoot $userDataRoot -ProfileDirectory $profile -ExtensionDirectory $installed.path -StartUrl $StartUrl
    Start-Process -FilePath $browser.path -ArgumentList $arguments
}
