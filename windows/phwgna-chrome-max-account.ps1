param(
    [switch]$Launch,
    [switch]$LaunchOnly,
    [switch]$RefreshProfile,
    [string]$StartUrl = 'https://sangtacviet.com/mybook/'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'phwgna-setup-core.ps1')

$packageRoot = Split-Path -Parent $PSScriptRoot
$browser = @(Find-PhwgnaBrowsers) | Where-Object { $_.id -eq 'chrome' } | Select-Object -First 1
if (-not $browser) { throw 'Không tìm thấy Google Chrome trên máy này.' }

$sourceUserDataRoot = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$stateRoot = Join-Path $env:LOCALAPPDATA 'phwgna-stv-chrome-max'
$maxProfileRoot = Join-Path $stateRoot 'profile'
$metadataPath = Join-Path $stateRoot 'profile-clone.json'

if (-not $LaunchOnly) {
    $installed = Install-PhwgnaExtension -SourceDirectory $packageRoot -DestinationRoot $stateRoot
    $result = New-PhwgnaAccountChromeShortcut -Browser $browser -LauncherScript $MyInvocation.MyCommand.Path -StartUrl $StartUrl
    Write-Host "Đã tạo Chrome STV Max dùng bản clone tài khoản hiện tại: $($result.path)"
}

if (-not ($Launch -or $LaunchOnly)) { exit 0 }

$installed = Install-PhwgnaExtension -SourceDirectory $packageRoot -DestinationRoot $stateRoot
$maxState = Get-PhwgnaChromeLaunchState -UserDataRoot $maxProfileRoot -ExtensionDirectory $installed.path
$cloneReady = (Test-Path -LiteralPath (Join-Path $maxProfileRoot 'Local State') -PathType Leaf) `
    -and (Test-Path -LiteralPath $metadataPath -PathType Leaf)

if ($RefreshProfile -or -not $cloneReady) {
    # Copy-PhwgnaChromeProfile refuses every live chrome.exe process. This is
    # deliberate: copying SQLite cookies or extension state from a live profile
    # can silently produce a half-valid clone.
    $sourceProfile = Get-PhwgnaChromeProfileDirectory -UserDataRoot $sourceUserDataRoot
    $chromeVersion = [string](Get-Item -LiteralPath $browser.path).VersionInfo.ProductVersion
    Copy-PhwgnaChromeProfile `
        -SourceUserDataRoot $sourceUserDataRoot `
        -DestinationUserDataRoot $maxProfileRoot `
        -ProfileDirectory $sourceProfile `
        -ChromeVersion $chromeVersion | Out-Null
    $maxState = 'closed'
}

try {
    $maxProfile = Get-PhwgnaChromeProfileDirectory -UserDataRoot $maxProfileRoot
} catch {
    throw 'Chrome STV Max chưa có profile clone hợp lệ. Hãy đóng toàn bộ Chrome rồi chạy lại một lần.'
}

if ($maxState -eq 'max_running') {
    $verification = Test-PhwgnaChromeMaxProcess -ProfileRoot $maxProfileRoot -ExtensionDirectory $installed.path
    if (-not $verification.ok) {
        throw ('Chrome STV Max đang chạy nhưng thiếu cờ: ' + ($verification.missingFlags -join ', '))
    }
    $reuseArguments = '--user-data-dir="' + $maxProfileRoot + '" --profile-directory="' + $maxProfile + '" --new-tab "' + $StartUrl + '"'
    Start-Process -FilePath $browser.path -ArgumentList $reuseArguments
    exit 0
}

# Preferences are only edited while the cloned browser is closed. Unrelated
# keys are retained and both JSON files are replaced atomically.
Set-PhwgnaChromeMaxPreferences -UserDataRoot $maxProfileRoot -ProfileDirectory $maxProfile | Out-Null
$arguments = Get-PhwgnaDedicatedChromeArguments `
    -ProfileRoot $maxProfileRoot `
    -ProfileDirectory $maxProfile `
    -ExtensionDirectory $installed.path `
    -StartUrl $StartUrl
Start-Process -FilePath $browser.path -ArgumentList $arguments

$verification = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 250
    $verification = Test-PhwgnaChromeMaxProcess -ProfileRoot $maxProfileRoot -ExtensionDirectory $installed.path
    if ($verification.ok) { break }
}
if (-not $verification.ok) {
    throw ('Chrome đã mở nhưng chưa chạy đúng chế độ Max. Cờ còn thiếu: ' + ($verification.missingFlags -join ', '))
}
Write-Host 'Chrome STV Max đã chạy bằng profile clone và đủ cờ hiệu năng nền.'
