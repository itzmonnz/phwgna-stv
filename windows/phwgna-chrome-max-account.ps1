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
    # A running normal Chrome process can open a new tab in the same profile.
    # Check the saved unpacked extension before deciding whether a new process
    # is required; the old order incorrectly blocked this path and demanded
    # that every Chrome window be closed first.
    $installed = Install-PhwgnaExtension -SourceDirectory $packageRoot -DestinationRoot $stateRoot
    $extensionSaved = Test-PhwgnaChromeExtensionInstalled -UserDataRoot $userDataRoot -ProfileDirectory $profile -ExtensionDirectory $installed.path
    $launchState = Get-PhwgnaChromeLaunchState -UserDataRoot $userDataRoot -ExtensionDirectory $installedPath
    if ($extensionSaved -and ($launchState -eq 'max_running' -or $launchState -eq 'browser_running')) {
        $openArguments = '--profile-directory="' + $profile + '" --new-tab "' + $StartUrl + '"'
        Start-Process -FilePath $browser.path -ArgumentList $openArguments
        exit 0
    }
    if (-not $extensionSaved) {
        $setupArguments = '--profile-directory="' + $profile + '" --new-window "chrome://extensions/"'
        Start-Process -FilePath $browser.path -ArgumentList $setupArguments
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + (Join-Path $installed.path 'manifest.json') + '"')
        Write-Warning "Chrome chưa lưu extension STV. Hãy bật Chế độ nhà phát triển, chọn Tải tiện ích đã giải nén và chọn thư mục: $($installed.path). Không cần đóng Chrome; sau khi tải xong chỉ cần reload trang STV."
        exit 3
    }
    $arguments = Get-PhwgnaDedicatedChromeArguments -ProfileRoot $userDataRoot -ProfileDirectory $profile -ExtensionDirectory $installed.path -StartUrl $StartUrl
    Start-Process -FilePath $browser.path -ArgumentList $arguments
}
