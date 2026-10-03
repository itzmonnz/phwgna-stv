param(
    [switch]$Launch,
    [switch]$LaunchOnly,
    [switch]$EnsureRunning,
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
$extensionDirectory = $packageRoot
$maxProfileRoot = Join-Path $stateRoot 'profile'
$metadataPath = Join-Path $stateRoot 'profile-clone.json'
$packageValidation = Test-PhwgnaExtensionPackage -SourceDirectory $extensionDirectory
if (-not $packageValidation.ok) { throw "$($packageValidation.code):$($packageValidation.file)" }

if (-not $LaunchOnly) {
    $result = New-PhwgnaAccountChromeShortcut -Browser $browser -LauncherScript $MyInvocation.MyCommand.Path -StartUrl $StartUrl -PinToTaskbar
    Write-Host "Đã tạo Chrome STV Max dùng bản clone tài khoản hiện tại: $($result.path)"
}

if (-not ($Launch -or $LaunchOnly)) { exit 0 }

$maxState = Get-PhwgnaChromeLaunchState -UserDataRoot $maxProfileRoot -ExtensionDirectory $extensionDirectory
$cloneReady = (Test-Path -LiteralPath (Join-Path $maxProfileRoot 'Local State') -PathType Leaf) `
    -and (Test-Path -LiteralPath $metadataPath -PathType Leaf)
$sourceProfile = Get-PhwgnaChromeProfileDirectory -UserDataRoot $sourceUserDataRoot
if (-not $RefreshProfile -and $cloneReady -and $maxState -ne 'max_running') {
    $maxProfile = Get-PhwgnaChromeProfileDirectory -UserDataRoot $maxProfileRoot
    if ((Test-PhwgnaChromeProfileIdentity -UserDataRoot $sourceUserDataRoot -ProfileDirectory $sourceProfile) `
        -and -not (Test-PhwgnaChromeProfileIdentity -UserDataRoot $maxProfileRoot -ProfileDirectory $maxProfile)) {
        $RefreshProfile = $true
    }
}

if ($RefreshProfile -or -not $cloneReady) {
    # Copy-PhwgnaChromeProfile refuses every live chrome.exe process. This is
    # deliberate: copying SQLite cookies or extension state from a live profile
    # can silently produce a half-valid clone.
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
    $verification = Test-PhwgnaChromeMaxProcess -ProfileRoot $maxProfileRoot -ExtensionDirectory $extensionDirectory
    if (-not $verification.ok) {
        throw ('Chrome STV Max đang chạy nhưng thiếu cờ: ' + ($verification.missingFlags -join ', '))
    }
    Start-PhwgnaSunshineWatcher -SourceDirectory $PSScriptRoot | Out-Null
    if ($EnsureRunning) { exit 0 }
    $reuseArguments = '--user-data-dir="' + $maxProfileRoot + '" --profile-directory="' + $maxProfile + '" --new-tab "' + $StartUrl + '"'
    Start-Process -FilePath $browser.path -ArgumentList $reuseArguments
    exit 0
}

# Do not deserialize and rewrite Chrome's profile JSON here. Chrome protects
# account metadata inside these files and can discard the copied identity after
# a generic PowerShell JSON rewrite. Runtime flags below provide the Max tuning
# without changing the user's cloned account or extension state.
$arguments = Get-PhwgnaDedicatedChromeArguments `
    -ProfileRoot $maxProfileRoot `
    -ProfileDirectory $maxProfile `
    -ExtensionDirectory $extensionDirectory `
    -StartUrl $StartUrl
Start-Process -FilePath $browser.path -ArgumentList $arguments

$verification = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 250
    $verification = Test-PhwgnaChromeMaxProcess -ProfileRoot $maxProfileRoot -ExtensionDirectory $extensionDirectory
    if ($verification.ok) { break }
}
if (-not $verification.ok) {
    throw ('Chrome đã mở nhưng chưa chạy đúng chế độ Max. Cờ còn thiếu: ' + ($verification.missingFlags -join ', '))
}
Start-PhwgnaSunshineWatcher -SourceDirectory $PSScriptRoot | Out-Null
Write-Host 'Chrome STV Max đã chạy bằng profile clone và đủ cờ hiệu năng nền.'
