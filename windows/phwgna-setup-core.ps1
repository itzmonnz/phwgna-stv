$ErrorActionPreference = 'Stop'

function Read-PhwgnaThirdPartyLock {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'third_party_lock_missing' }
    try { $lock = Get-Content -Raw -LiteralPath $resolved | ConvertFrom-Json }
    catch { throw 'third_party_lock_invalid' }
    if ($lock.schemaVersion -ne 1 -or -not $lock.sunshine.packages.AMD64 -or -not $lock.sunshine.packages.ARM64 -or -not $lock.artemis.apkUrl) {
        throw 'third_party_lock_invalid'
    }
    foreach ($package in @($lock.sunshine.packages.AMD64, $lock.sunshine.packages.ARM64)) {
        if ([string]$package.sha256 -notmatch '^[0-9a-f]{64}$' -or [string]$package.url -notmatch '^https://github\.com/LizardByte/Sunshine/releases/download/v[^/]+/Sunshine-Windows-(AMD64|ARM64)-installer\.msi$') {
            throw 'third_party_lock_invalid'
        }
    }
    if ([string]$lock.artemis.sha256 -notmatch '^[0-9a-f]{64}$' -or [string]$lock.artemis.apkUrl -notmatch '^https://github\.com/ClassicOldSong/moonlight-android/releases/download/v[^/]+/artemis-nonRoot_game-release\.apk$') {
        throw 'third_party_lock_invalid'
    }
    if ([string]$lock.sunshine.releaseUrl -notmatch '^https://github\.com/LizardByte/Sunshine/releases/tag/v[^/]+$' `
        -or [string]$lock.artemis.releaseUrl -notmatch '^https://github\.com/ClassicOldSong/moonlight-android/releases/tag/v[^/]+$' `
        -or [string]$lock.tailscale.packageId -ne 'Tailscale.Tailscale' `
        -or [string]$lock.tailscale.windowsGuideUrl -ne 'https://tailscale.com/docs/install/windows' `
        -or [string]$lock.tailscale.androidGuideUrl -ne 'https://tailscale.com/docs/install/android') {
        throw 'third_party_lock_invalid'
    }
    $lock
}

function Get-PhwgnaWindowsArchitecture {
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -match 'ARM64') { return 'ARM64' }
    if ($architecture -match 'AMD64') { return 'AMD64' }
    throw 'unsupported_architecture'
}

function Get-PhwgnaSetupPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('pc','phone')][string]$Mode,
        [Parameter(Mandatory)][bool]$UseTailscale,
        [Parameter(Mandatory)][psobject]$Lock
    )
    $phone = $Mode -eq 'phone'
    [pscustomobject]@{
        mode = $Mode
        installSunshine = $phone
        installTailscale = $phone -and $UseTailscale
        needsElevation = $phone
        artemisUrl = [string]$Lock.artemis.apkUrl
    }
}

function Test-PhwgnaSunshineInstaller {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ ok=$false; code='installer_missing' }
    }
    $stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($Path))
    try {
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $actual = ([BitConverter]::ToString($hasher.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
        finally { $hasher.Dispose() }
    } finally { $stream.Dispose() }
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        return [pscustomobject]@{ ok=$false; code='hash_mismatch' }
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ([string]$signature.Status -ne 'Valid') {
        return [pscustomobject]@{ ok=$false; code='signature_invalid' }
    }
    [pscustomobject]@{ ok=$true; code='ready' }
}

function Get-PhwgnaSunshineState {
    $service = Get-Service -Name 'SunshineService' -ErrorAction SilentlyContinue
    if (-not $service) { return [pscustomobject]@{ installed=$false; running=$false } }
    [pscustomobject]@{ installed=$true; running=([string]$service.Status -eq 'Running') }
}

function Install-PhwgnaSunshineIfMissing {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][psobject]$Lock,
        [string]$DownloadRoot = (Join-Path $env:TEMP 'phwgna-stv-setup'),
        [switch]$DryRun
    )
    $state = Get-PhwgnaSunshineState
    if ($state.installed -and $state.running) { return [pscustomobject]@{ ok=$true; code='already_installed'; running=$true } }
    if ($state.installed) { return [pscustomobject]@{ ok=$false; code='service_not_running' } }
    $architecture = Get-PhwgnaWindowsArchitecture
    $package = $Lock.sunshine.packages.$architecture
    if (-not $package) { throw 'unsupported_architecture' }
    if ($DryRun) { return [pscustomobject]@{ ok=$true; code='sunshine_ready'; architecture=$architecture; dryRun=$true } }

    $downloadDirectory = Join-Path ([IO.Path]::GetFullPath($DownloadRoot)) ([string]$Lock.sunshine.version)
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    $installer = Join-Path $downloadDirectory "Sunshine-Windows-$architecture-installer.msi"
    try { Invoke-WebRequest -Uri ([string]$package.url) -OutFile $installer -UseBasicParsing }
    catch { return [pscustomobject]@{ ok=$false; code='download_failed' } }
    $validation = Test-PhwgnaSunshineInstaller -Path $installer -ExpectedSha256 ([string]$package.sha256)
    if (-not $validation.ok) { return $validation }

    try {
        $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"{0}"' -f $installer), '/qn', '/norestart') -Verb RunAs -Wait -PassThru
    } catch {
        return [pscustomobject]@{ ok=$false; code='uac_or_install_cancelled' }
    }
    if ($process.ExitCode -notin @(0,3010)) { return [pscustomobject]@{ ok=$false; code='install_failed' } }
    $installed = Get-PhwgnaSunshineState
    if (-not $installed.installed) { return [pscustomobject]@{ ok=$false; code='service_missing' } }
    [pscustomobject]@{ ok=$true; code='installed'; running=$installed.running; rebootRequired=($process.ExitCode -eq 3010) }
}

function Install-PhwgnaTailscaleIfSelected {
    [CmdletBinding()]
    param([Parameter(Mandatory)][bool]$Selected, [Parameter(Mandatory)][psobject]$Lock, [switch]$DryRun)
    if (-not $Selected) { return [pscustomobject]@{ ok=$true; code='skipped' } }
    if (Get-Command tailscale.exe -ErrorAction SilentlyContinue) { return [pscustomobject]@{ ok=$true; code='already_installed' } }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { return [pscustomobject]@{ ok=$false; code='winget_missing'; guideUrl=[string]$Lock.tailscale.windowsGuideUrl } }
    if ($DryRun) { return [pscustomobject]@{ ok=$true; code='tailscale_ready'; dryRun=$true } }
    & $winget.Source install --id ([string]$Lock.tailscale.packageId) --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ ok=$false; code='tailscale_install_failed'; guideUrl=[string]$Lock.tailscale.windowsGuideUrl } }
    [pscustomobject]@{ ok=$true; code='installed' }
}

function Get-PhwgnaLanAddress {
    $candidate = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Sort-Object InterfaceMetric |
        Select-Object -First 1
    if ($candidate) { return [string]$candidate.IPAddress }
    ''
}

function Get-PhwgnaBrowserCandidates {
    @{
        chrome = @(
            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
            (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
        )
        coccoc = @(
            (Join-Path $env:LOCALAPPDATA 'CocCoc\Browser\Application\browser.exe'),
            (Join-Path $env:ProgramFiles 'CocCoc\Browser\Application\browser.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'CocCoc\Browser\Application\browser.exe')
        )
    }
}

function Find-PhwgnaBrowsers {
    [CmdletBinding()]
    param([hashtable]$CandidatePaths = (Get-PhwgnaBrowserCandidates))
    $coccocName = [Regex]::Unescape('C\u1ed1c C\u1ed1c')
    $definitions = @(
        [pscustomobject]@{ id='chrome'; name='Google Chrome'; extensionsUrl='chrome://extensions/'; downloadUrl='https://www.google.com/chrome/' },
        [pscustomobject]@{ id='coccoc'; name=$coccocName; extensionsUrl='coccoc://extensions/'; downloadUrl='https://coccoc.com/vi/trinh-duyet' }
    )
    foreach ($definition in $definitions) {
        $path = @($CandidatePaths[$definition.id]) | Where-Object {
            $_ -and (Test-Path -LiteralPath $_ -PathType Leaf)
        } | Select-Object -First 1
        if ($path) {
            [pscustomobject]@{
                id = $definition.id
                name = $definition.name
                path = [IO.Path]::GetFullPath($path)
                extensionsUrl = $definition.extensionsUrl
                downloadUrl = $definition.downloadUrl
            }
        }
    }
}

function Get-PhwgnaPerformanceArguments {
    '--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows'
}

function New-PhwgnaPerformanceShortcut {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][psobject]$Browser,
        [string]$DesktopPath = [Environment]::GetFolderPath('Desktop'),
        [switch]$DryRun
    )
    if ($Browser.id -notin @('chrome','coccoc')) { throw 'unsupported_browser' }
    $browserPath = [IO.Path]::GetFullPath([string]$Browser.path)
    if (-not (Test-Path -LiteralPath $browserPath -PathType Leaf)) { throw 'browser_missing' }
    $desktop = [IO.Path]::GetFullPath($DesktopPath)
    if (-not (Test-Path -LiteralPath $desktop -PathType Container)) { throw 'desktop_missing' }

    $performanceArguments = Get-PhwgnaPerformanceArguments
    $shortcutPath = Join-Path $desktop 'phwgna stv.lnk'
    $description = 'phwgna STV - tang toc tab ChatGPT va Gemini chay nen'
    if ($DryRun) {
        return [pscustomobject]@{ ok=$true; code='shortcut_ready'; browser=[string]$Browser.id; path=$shortcutPath; dryRun=$true }
    }

    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        $existingShortcut = $shell.CreateShortcut($shortcutPath)
        $ownedDescriptions = @(
            $description,
            'phwgna stv - Coc Coc toi uu tab ChatGPT va Gemini nen',
            'Coc Coc toi uu tab Gemini nen cho phwgna STV AI Translator'
        )
        $owned = $existingShortcut.Description -in $ownedDescriptions `
            -and $existingShortcut.Arguments -eq $performanceArguments
        if (-not $owned) { throw 'shortcut_conflict' }
    }

    $shortcut = $shell.CreateShortcut($shortcutPath)
    try {
        $shortcut.TargetPath = $browserPath
    } catch {
        # Windows Script Host can reject a Unicode executable path on some
        # Windows builds. Its native short path still targets the same file
        # and does not create or select another browser profile.
        $fileSystem = New-Object -ComObject Scripting.FileSystemObject
        $shortBrowserPath = [string]$fileSystem.GetFile($browserPath).ShortPath
        if (-not $shortBrowserPath) { throw 'browser_path_unsupported' }
        $shortcut.TargetPath = $shortBrowserPath
    }
    $shortcut.Arguments = $performanceArguments
    $shortcut.WorkingDirectory = Split-Path -Parent $browserPath
    $shortcut.IconLocation = "$browserPath,0"
    $shortcut.Description = $description
    $shortcut.Save()
    [pscustomobject]@{ ok=$true; code='shortcut_created'; browser=[string]$Browser.id; path=$shortcutPath; dryRun=$false }
}

function Get-PhwgnaRequiredFiles {
    @(
        'manifest.json',
        'src/background.js',
        'popup/popup.html',
        'options/options.html',
        'assets/icons/phwgna-cat-16.png',
        'assets/icons/phwgna-cat-32.png',
        'assets/icons/phwgna-cat-48.png',
        'assets/icons/phwgna-cat-128.png'
    )
}

function Test-PhwgnaExtensionPackage {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SourceDirectory)
    $source = [IO.Path]::GetFullPath($SourceDirectory)
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        return [pscustomobject]@{ ok=$false; code='source_not_found'; file='' }
    }
    foreach ($relative in Get-PhwgnaRequiredFiles) {
        $file = Join-Path $source ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            return [pscustomobject]@{ ok=$false; code='missing_required_file'; file=$relative }
        }
    }
    try {
        $manifest = Get-Content -Raw -LiteralPath (Join-Path $source 'manifest.json') | ConvertFrom-Json
        if (-not $manifest.version -or ($manifest.manifest_version -and $manifest.manifest_version -ne 3)) {
            return [pscustomobject]@{ ok=$false; code='invalid_manifest'; file='manifest.json' }
        }
    } catch {
        return [pscustomobject]@{ ok=$false; code='invalid_manifest'; file='manifest.json' }
    }
    [pscustomobject]@{ ok=$true; code='ready'; file=''; version=[string]$manifest.version }
}

function Assert-PhwgnaInstallChild {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path)
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith("$resolvedRoot\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'unsafe_install_path'
    }
    $resolvedPath
}

function Install-PhwgnaExtension {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SourceDirectory,
        [Parameter(Mandatory)][string]$DestinationRoot,
        [switch]$DryRun
    )
    $source = [IO.Path]::GetFullPath($SourceDirectory)
    $validation = Test-PhwgnaExtensionPackage -SourceDirectory $source
    if (-not $validation.ok) { throw "$($validation.code):$($validation.file)" }
    $root = [IO.Path]::GetFullPath($DestinationRoot)
    $destination = Assert-PhwgnaInstallChild -Root $root -Path (Join-Path $root 'extension')
    if ($DryRun) {
        return [pscustomobject]@{ ok=$true; version=$validation.version; path=$destination; dryRun=$true }
    }
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $nonce = [Guid]::NewGuid().ToString('N')
    $staging = Assert-PhwgnaInstallChild -Root $root -Path (Join-Path $root "extension.staging-$nonce")
    $backup = Assert-PhwgnaInstallChild -Root $root -Path (Join-Path $root "extension.backup-$nonce")
    New-Item -ItemType Directory -Path $staging | Out-Null
    $productionItems = @('manifest.json','LICENSE','SECURITY.md','security','assets','src','options','popup','onboarding','_integrity')
    try {
        foreach ($item in $productionItems) {
            $candidate = Join-Path $source $item
            if (Test-Path -LiteralPath $candidate) {
                Copy-Item -LiteralPath $candidate -Destination (Join-Path $staging $item) -Recurse -Force
            }
        }
        $stagedValidation = Test-PhwgnaExtensionPackage -SourceDirectory $staging
        if (-not $stagedValidation.ok) { throw "$($stagedValidation.code):$($stagedValidation.file)" }
        if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination $backup }
        try {
            Move-Item -LiteralPath $staging -Destination $destination
        } catch {
            if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $destination }
            throw
        }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    }
    [pscustomobject]@{ ok=$true; version=$validation.version; path=$destination; dryRun=$false }
}

function Write-SetupLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][ValidateSet('environment','install','browser','wizard')][string]$Step,
        [Parameter(Mandatory)][ValidateSet('completed','manual','browser_missing','package_invalid','stopped')][string]$Code,
        [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
        [ValidateSet('','chrome','coccoc')][string]$Browser = ''
    )
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $record = [ordered]@{
        at = [DateTime]::UtcNow.ToString('o')
        browser = $Browser
        code = $Code
        step = $Step
        version = $Version
    }
    Add-Content -LiteralPath (Join-Path $StateRoot 'setup.log') -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
}
