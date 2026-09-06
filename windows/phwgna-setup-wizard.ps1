param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'phwgna-setup-core.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

# Source labels: Dùng trên PC; Dùng trên điện thoại; Đọc ngoài mạng nhà bằng Tailscale;
# Tạo shortcut tăng tốc; Artemis; Sunshine.
$packageRoot = Split-Path -Parent $PSScriptRoot
$extensionSource = if (Test-Path -LiteralPath (Join-Path $packageRoot 'extension\manifest.json')) { Join-Path $packageRoot 'extension' } else { $packageRoot }
$lock = Read-PhwgnaThirdPartyLock -Path (Join-Path $packageRoot 'third-party-lock.json')
$stateRoot = Join-Path $env:LOCALAPPDATA 'phwgna-stv-ai-translator'
$installRoot = $stateRoot
$installedExtension = Join-Path $installRoot 'extension'
$guidePath = Join-Path $packageRoot 'HUONG-DAN-PHWGNA-STV.html'
$ipHelperPath = Join-Path $packageRoot 'windows\phwgna-show-ip.ps1'
$browsers = @(Find-PhwgnaBrowsers)
$chromeExtensionsUrl = 'chrome://extensions/'
$coccocExtensionsUrl = 'coccoc://extensions/'
$ui = ConvertFrom-Json '["C\u00e0i phwgna STV","Ch\u1ecdn c\u00e1ch b\u1ea1n mu\u1ed1n d\u00f9ng","D\u00f9ng tr\u00ean PC","C\u00e0i extension v\u00e0 m\u1edf trang Extensions. Kh\u00f4ng c\u1ea7n Admin.","D\u00f9ng tr\u00ean \u0111i\u1ec7n tho\u1ea1i","PC l\u00e0m m\u00e1y ch\u1ee7 qua Sunshine; \u0111i\u1ec7n tho\u1ea1i \u0111i\u1ec1u khi\u1ec3n b\u1eb1ng Artemis.","\u0110\u1ecdc ngo\u00e0i m\u1ea1ng nh\u00e0 b\u1eb1ng Tailscale","Tr\u00ecnh duy\u1ec7t","T\u1ea3i tr\u00ecnh duy\u1ec7t","C\u00e0i / C\u1eadp nh\u1eadt","M\u1edf Extensions","M\u1edf th\u01b0 m\u1ee5c","T\u1ea1o shortcut t\u0103ng t\u1ed1c","M\u1edf h\u01b0\u1edbng d\u1eabn","S\u1eb5n s\u00e0ng. Ch\u1ecdn m\u1ed9t ch\u1ebf \u0111\u1ed9 r\u1ed3i b\u1ea5m C\u00e0i / C\u1eadp nh\u1eadt.","Ch\u01b0a t\u00ecm th\u1ea5y Chrome ho\u1eb7c C\u1ed1c C\u1ed1c.","\u0110\u00e3 chu\u1ea9n b\u1ecb extension. B\u1eadt Ch\u1ebf \u0111\u1ed9 d\u00e0nh cho nh\u00e0 ph\u00e1t tri\u1ec3n, b\u1ea5m T\u1ea3i ti\u1ec7n \u00edch \u0111\u00e3 gi\u1ea3i n\u00e9n v\u00e0 ch\u1ecdn th\u01b0 m\u1ee5c v\u1eeba m\u1edf.","\u0110ang ki\u1ec3m tra v\u00e0 c\u00e0i Sunshine. Windows c\u00f3 th\u1ec3 h\u1ecfi quy\u1ec1n m\u1ed9t l\u1ea7n...","Sunshine \u0111\u00e3 s\u1eb5n s\u00e0ng. T\u1ea1o t\u00e0i kho\u1ea3n t\u1ea1i trang v\u1eeba m\u1edf, c\u00e0i Artemis b\u1eb1ng QR, th\u00eam IP PC r\u1ed3i nh\u1eadp PIN \u1edf Sunshine.","Kh\u00f4ng c\u00e0i \u0111\u01b0\u1ee3c Sunshine an to\u00e0n. Kh\u00f4ng c\u00f3 file n\u00e0o ch\u01b0a x\u00e1c minh \u0111\u01b0\u1ee3c ch\u1ea1y.","Tailscale c\u1ea7n c\u00e0i th\u1ee7 c\u00f4ng. Trang h\u01b0\u1edbng d\u1eabn ch\u00ednh th\u1ee9c \u0111\u00e3 \u0111\u01b0\u1ee3c m\u1edf.","Kh\u00f4ng th\u1ec3 chu\u1ea9n b\u1ecb extension; b\u1ea3n c\u00e0i c\u0169 v\u1eabn \u0111\u01b0\u1ee3c gi\u1eef nguy\u00ean."]'

$form = New-Object Windows.Forms.Form
$form.Text = $ui[0]
$form.Size = New-Object Drawing.Size(780,830)
$form.MinimumSize = New-Object Drawing.Size(780,830)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [Drawing.Color]::FromArgb(18,20,28)
$form.ForeColor = [Drawing.Color]::White
$form.Font = New-Object Drawing.Font('Segoe UI',10)

function Add-Label([string]$Text,[int]$X,[int]$Y,[int]$Width,[int]$Height,[int]$Size=10,[bool]$Strong=$false) {
    $label = New-Object Windows.Forms.Label
    $label.Text = $Text
    $style = if ($Strong) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
    $label.Font = New-Object Drawing.Font('Segoe UI',$Size,$style)
    $label.SetBounds($X,$Y,$Width,$Height)
    $label.ForeColor = if ($Strong) { [Drawing.Color]::White } else { [Drawing.Color]::FromArgb(194,198,214) }
    $form.Controls.Add($label)
    $label
}

[void](Add-Label $ui[1] 30 22 700 40 20 $true)
$pcMode = New-Object Windows.Forms.RadioButton
$pcMode.Text = $ui[2]
$pcMode.Checked = $true
$pcMode.SetBounds(34,86,250,34)
$pcMode.Font = New-Object Drawing.Font('Segoe UI Semibold',12)
$form.Controls.Add($pcMode)
[void](Add-Label $ui[3] 62 120 660 42)
$phoneMode = New-Object Windows.Forms.RadioButton
$phoneMode.Text = $ui[4]
$phoneMode.SetBounds(34,170,300,34)
$phoneMode.Font = New-Object Drawing.Font('Segoe UI Semibold',12)
$form.Controls.Add($phoneMode)
[void](Add-Label $ui[5] 62 204 500 42)
$artemisQr = New-Object Windows.Forms.PictureBox
$artemisQr.ImageLocation = Join-Path $packageRoot 'windows\assets\artemis-qr.png'
$artemisQr.SizeMode = 'Zoom'
$artemisQr.SetBounds(610,154,112,112)
$artemisQr.Visible = $false
$form.Controls.Add($artemisQr)
$tailscale = New-Object Windows.Forms.CheckBox
$tailscale.Text = $ui[6]
$tailscale.Checked = $false
$tailscale.Enabled = $false
$tailscale.SetBounds(62,248,420,36)
$form.Controls.Add($tailscale)

[void](Add-Label $ui[7] 32 306 160 24 10 $true)
$browserSelect = New-Object Windows.Forms.ComboBox
$browserSelect.DropDownStyle = 'DropDownList'
$browserSelect.SetBounds(32,334,430,34)
foreach ($browser in $browsers) { [void]$browserSelect.Items.Add($browser.name) }
if ($browserSelect.Items.Count) { $browserSelect.SelectedIndex = 0 }
$form.Controls.Add($browserSelect)

function New-SetupButton([string]$Text,[int]$X,[int]$Y,[int]$Width,[Drawing.Color]$Color) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $Text
    $button.SetBounds($X,$Y,$Width,44)
    $button.FlatStyle = 'Flat'
    $button.FlatAppearance.BorderSize = 0
    $button.BackColor = $Color
    $button.ForeColor = [Drawing.Color]::White
    $form.Controls.Add($button)
    $button
}

$secondary = [Drawing.Color]::FromArgb(43,46,61)
$primary = [Drawing.Color]::FromArgb(99,102,241)
$download = New-SetupButton $ui[8] 478 350 250 $secondary
$install = New-SetupButton $ui[9] 32 420 220 $primary
$openExtensions = New-SetupButton $ui[10] 266 420 210 $secondary
$openFolder = New-SetupButton $ui[11] 490 420 238 $secondary
$performance = New-SetupButton $ui[12] 32 476 340 ([Drawing.Color]::FromArgb(8,105,130))
$guide = New-SetupButton $ui[13] 388 476 340 $secondary
$artemisDownload = New-SetupButton 'Tải Artemis cho Android' 548 276 180 $secondary
$showIp = New-SetupButton 'Lấy IP kết nối' 352 276 180 ([Drawing.Color]::FromArgb(8,105,130))
$artemisDownload.Visible = $false
$showIp.Visible = $false
$install.Enabled = $browsers.Count -gt 0
$performance.Enabled = $browsers.Count -gt 0
$status = Add-Label $(if ($browsers.Count) { $ui[14] } else { $ui[15] }) 32 548 696 116
$status.BorderStyle = 'FixedSingle'
$status.Padding = New-Object Windows.Forms.Padding(12)
$status.BackColor = [Drawing.Color]::FromArgb(26,29,40)

$phoneMode.Add_CheckedChanged({
    $tailscale.Enabled = $phoneMode.Checked
    $artemisQr.Visible = $phoneMode.Checked
    $artemisDownload.Visible = $phoneMode.Checked
    $showIp.Visible = $phoneMode.Checked
    if (-not $phoneMode.Checked) { $tailscale.Checked = $false }
})
function Selected-Browser { if ($browserSelect.SelectedIndex -ge 0 -and $browserSelect.SelectedIndex -lt $browsers.Count) { $browsers[$browserSelect.SelectedIndex] } }
function Open-ExtensionsPage { $browser=Selected-Browser; if ($browser -and -not $DryRun) { Start-Process -FilePath $browser.path -ArgumentList $browser.extensionsUrl } }
$download.Add_Click({ $browser=Selected-Browser; $url=if($browser){$browser.downloadUrl}else{'https://www.google.com/chrome/'}; if(-not $DryRun){Start-Process $url} })
$openExtensions.Add_Click({ Open-ExtensionsPage })
$openFolder.Add_Click({ if(Test-Path -LiteralPath $installedExtension){Start-Process explorer.exe -ArgumentList $installedExtension}else{$status.Text=$ui[21]} })
$guide.Add_Click({ if(Test-Path -LiteralPath $guidePath){Start-Process $guidePath} })
$artemisDownload.Add_Click({ if(-not $DryRun){Start-Process ([string]$lock.artemis.apkUrl)} })
$showIp.Add_Click({
    if (-not $DryRun -and (Test-Path -LiteralPath $ipHelperPath)) {
        Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$ipHelperPath`""
    }
})
$performance.Add_Click({
    $browser=Selected-Browser; if(-not $browser){$status.Text=$ui[15];return}
    try { [void](New-PhwgnaPerformanceShortcut -Browser $browser -DryRun:$DryRun); $status.Text=[Regex]::Unescape('\u0110\u00e3 t\u1ea1o shortcut t\u0103ng t\u1ed1c tr\u00ean Desktop.') }
    catch { $status.Text=[Regex]::Unescape('Kh\u00f4ng t\u1ea1o \u0111\u01b0\u1ee3c shortcut t\u0103ng t\u1ed1c. Shortcut ri\u00eang c\u1ee7a b\u1ea1n kh\u00f4ng b\u1ecb ghi \u0111\u00e8.') }
})
$install.Add_Click({
    $install.Enabled=$false
    try {
        $extension = Install-PhwgnaExtension -SourceDirectory $extensionSource -DestinationRoot $installRoot -DryRun:$DryRun
        $browser = Selected-Browser
        if (-not $DryRun) {
            Write-SetupLog -StateRoot $stateRoot -Step 'install' -Code 'completed' -Version $extension.version -Browser $(if($browser){$browser.id}else{''})
        }
        if ($pcMode.Checked) { $status.Text=$ui[16] }
        else {
            $status.Text=$ui[17]
            $status.Refresh()
            [Windows.Forms.Application]::DoEvents()
            $sunshine = Install-PhwgnaSunshineIfMissing -Lock $lock -DryRun:$DryRun
            if (-not $sunshine.ok) {
                if ($sunshine.code -eq 'service_not_running') {
                    $status.Text=[Regex]::Unescape('Sunshine \u0111\u00e3 c\u00e0i nh\u01b0ng ch\u01b0a ch\u1ea1y. H\u00e3y m\u1edf Sunshine t\u1eeb menu Start r\u1ed3i th\u1eed l\u1ea1i.')
                } else {
                    $status.Text="$($ui[19]) Code: $($sunshine.code)"
                    if(-not $DryRun){Start-Process ([string]$lock.sunshine.releaseUrl)}
                }
                return
            }
            $tail = Install-PhwgnaTailscaleIfSelected -Selected $tailscale.Checked -Lock $lock -DryRun:$DryRun
            if (-not $tail.ok -and $tail.guideUrl -and -not $DryRun) { Start-Process ([string]$tail.guideUrl); $status.Text=$ui[20] }
            else {
                $ip=Get-PhwgnaLanAddress
                if ($ip) {
                    try { Set-Clipboard -Value $ip } catch { }
                    $status.Text="$($ui[18])`r`nIP cùng Wi-Fi: $ip (đã sao chép)"
                } else {
                    $status.Text="$($ui[18])`r`nBấm Lấy IP kết nối sau khi PC đã vào Wi-Fi."
                }
            }
            if (-not $DryRun) { Start-Process 'https://localhost:47990' }
        }
        if (-not $DryRun) { Open-ExtensionsPage; Start-Process explorer.exe -ArgumentList $extension.path }
    } catch { $status.Text="$($ui[21]) Code: $($_.Exception.Message)" }
    finally { $install.Enabled=$browsers.Count -gt 0 }
})

[void]$form.ShowDialog()
