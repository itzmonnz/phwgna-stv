param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'phwgna-setup-core.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

# Source labels: Dùng trên PC; Dùng trên điện thoại; Đọc ngoài mạng nhà bằng Tailscale;
# Tạo shortcut tăng tốc; Artemis; Sunshine.
$packageRoot = Split-Path -Parent $PSScriptRoot
$lock = Read-PhwgnaThirdPartyLock -Path (Join-Path $packageRoot 'third-party-lock.json')
$guidePath = Join-Path $packageRoot 'HUONG-DAN-PHWGNA-STV.html'
$ipHelperPath = Join-Path $packageRoot 'windows\phwgna-show-ip.ps1'
$installPageUrl = 'https://itzmonnz.github.io/phwgna-stv/install/'
$toolsPageUrl = 'https://itzmonnz.github.io/phwgna-stv/tools/'
$browsers = @(Find-PhwgnaBrowsers)

$form = New-Object Windows.Forms.Form
$form.Text = 'Cài Phwgna Stv'
$form.ClientSize = New-Object Drawing.Size(760,680)
$form.MinimumSize = New-Object Drawing.Size(776,719)
$form.MaximizeBox = $false
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

[void](Add-Label 'Cài Phwgna Stv' 32 22 696 38 20 $true)
[void](Add-Label 'Làm lần lượt theo 3 bước. Các nút mở trang web đều được ghi rõ.' 32 58 696 28)
[void](Add-Label 'Bước 1 · Chọn thiết bị' 32 94 696 26 11 $true)
$pcMode = New-Object Windows.Forms.RadioButton
$pcMode.Text = 'PC này'
$pcMode.Checked = $true
$pcMode.SetBounds(40,126,300,30)
$pcMode.Font = New-Object Drawing.Font('Segoe UI Semibold',12)
$pcMode.TabIndex = 0
$form.Controls.Add($pcMode)
[void](Add-Label 'Cài tiện ích vào Chrome hoặc Cốc Cốc. Không cần quyền Admin.' 66 156 292 40)
$phoneMode = New-Object Windows.Forms.RadioButton
$phoneMode.Text = 'Điện thoại'
$phoneMode.SetBounds(390,126,300,30)
$phoneMode.Font = New-Object Drawing.Font('Segoe UI Semibold',12)
$phoneMode.TabIndex = 1
$form.Controls.Add($phoneMode)
[void](Add-Label 'PC chạy Sunshine; điện thoại điều khiển bằng Artemis.' 416 156 292 40)

$divider1 = New-Object Windows.Forms.Label
$divider1.BackColor = [Drawing.Color]::FromArgb(49,53,68)
$divider1.SetBounds(32,207,696,1)
$form.Controls.Add($divider1)
[void](Add-Label 'Bước 2 · Chọn trình duyệt' 32 224 696 26 11 $true)
$browserSelect = New-Object Windows.Forms.ComboBox
$browserSelect.DropDownStyle = 'DropDownList'
$browserSelect.SetBounds(32,258,696,36)
$browserSelect.TabIndex = 2
foreach ($browser in $browsers) { [void]$browserSelect.Items.Add($browser.name) }
if ($browserSelect.Items.Count) { $browserSelect.SelectedIndex = 0 }
else { [void]$browserSelect.Items.Add('Chưa tìm thấy Chrome hoặc Cốc Cốc'); $browserSelect.SelectedIndex = 0 }
$form.Controls.Add($browserSelect)

function New-SetupButton([string]$Text,[int]$X,[int]$Y,[int]$Width,[Drawing.Color]$Color) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $Text
    $button.SetBounds($X,$Y,$Width,44)
    $button.FlatStyle = 'Flat'
    $button.FlatAppearance.BorderSize = 0
    $button.BackColor = $Color
    $button.ForeColor = [Drawing.Color]::White
    $button.Cursor = [Windows.Forms.Cursors]::Hand
    $form.Controls.Add($button)
    $button
}

$secondary = [Drawing.Color]::FromArgb(43,46,61)
$primary = [Drawing.Color]::FromArgb(99,102,241)
$positive = [Drawing.Color]::FromArgb(8,105,130)
$download = New-SetupButton 'Mở trang tải Chrome' 500 258 228 $secondary
$download.Visible = $browsers.Count -eq 0
$download.TabIndex = 3
if (-not $browsers.Count) { $browserSelect.SetBounds(32,258,456,36) }

$divider2 = New-Object Windows.Forms.Label
$divider2.BackColor = [Drawing.Color]::FromArgb(49,53,68)
$divider2.SetBounds(32,318,696,1)
$form.Controls.Add($divider2)
[void](Add-Label 'Bước 3 · Chuẩn bị' 32 335 696 26 11 $true)
$install = New-SetupButton 'Mở trang cài Phwgna Stv' 32 369 696 $primary
$install.SetBounds(32, 369, 696, 52)
$install.Font = New-Object Drawing.Font('Segoe UI Semibold',11)
$install.TabIndex = 4
$install.Enabled = $browsers.Count -gt 0

$phoneHeading = Add-Label 'Kết nối điện thoại' 32 405 696 26 11 $true
$artemisQr = New-Object Windows.Forms.PictureBox
$artemisQr.ImageLocation = Join-Path $packageRoot 'windows\assets\artemis-qr.png'
$artemisQr.SizeMode = 'Zoom'
$artemisQr.SetBounds(32,437,76,76)
$form.Controls.Add($artemisQr)
$tailscale = New-Object Windows.Forms.CheckBox
$tailscale.Text = 'Đọc ngoài mạng nhà bằng Tailscale'
$tailscale.Checked = $false
$tailscale.SetBounds(124,481,330,32)
$tailscale.TabIndex = 7
$form.Controls.Add($tailscale)
$showIp = New-SetupButton 'Lấy IP kết nối (tự sao chép)' 124 437 280 $positive
$showIp.TabIndex = 5
$artemisDownload = New-SetupButton 'Sao chép link tải Artemis' 416 437 312 $secondary
$artemisDownload.TabIndex = 6

$supportHeading = Add-Label 'Công cụ hỗ trợ' 32 405 696 26 11 $true
$openInstall = New-SetupButton 'Mở trang cài extension' 32 437 220 $secondary
$openInstall.TabIndex = 8
$openTools = New-SetupButton 'Mở trang tải Công cụ' 264 437 220 $secondary
$openTools.TabIndex = 9
$guide = New-SetupButton 'Xem hướng dẫn trong trình duyệt' 496 437 232 $secondary
$guide.TabIndex = 10
$performance = New-SetupButton 'Tạo shortcut tăng tốc' 32 489 696 $positive
$performance.TabIndex = 11
$performance.Enabled = $browsers.Count -gt 0
$status = Add-Label $(if ($browsers.Count) { 'Sẵn sàng. Chọn thiết bị rồi bấm nút tím ở Bước 3.' } else { 'Chưa tìm thấy Chrome hoặc Cốc Cốc. Hãy mở trang tải trình duyệt trước.' }) 32 549 696 64
$status.BorderStyle = 'FixedSingle'
$status.Padding = New-Object Windows.Forms.Padding(12)
$status.BackColor = [Drawing.Color]::FromArgb(26,29,40)

function Update-WizardMode {
    $phone = $phoneMode.Checked
    $install.Text = if ($phone) { 'Chuẩn bị PC cho điện thoại' } else { 'Mở trang cài Phwgna Stv' }
    foreach ($control in @($phoneHeading,$artemisQr,$tailscale,$artemisDownload,$showIp)) { $control.Visible = $phone }
    if (-not $phone) { $tailscale.Checked = $false }
    $supportY = if ($phone) { 521 } else { 405 }
    $supportHeading.SetBounds(32,$supportY,696,26)
    $openInstall.SetBounds(32,($supportY+32),220,44)
    $openTools.SetBounds(264,($supportY+32),220,44)
    $guide.SetBounds(496,($supportY+32),232,44)
    $performance.SetBounds(32,($supportY+84),696,44)
    $status.SetBounds(32,($supportY+144),696,64)
    $form.ClientSize = New-Object Drawing.Size(760,($supportY+220))
}
$phoneMode.Add_CheckedChanged({ Update-WizardMode })
$pcMode.Add_CheckedChanged({ Update-WizardMode })
function Selected-Browser { if ($browserSelect.SelectedIndex -ge 0 -and $browserSelect.SelectedIndex -lt $browsers.Count) { $browsers[$browserSelect.SelectedIndex] } }
$download.Add_Click({ if(-not $DryRun){Start-Process 'https://www.google.com/chrome/'} })
$openInstall.Add_Click({ if(-not $DryRun){Start-Process $installPageUrl} })
$openTools.Add_Click({ if(-not $DryRun){Start-Process $toolsPageUrl} })
$guide.Add_Click({ if(Test-Path -LiteralPath $guidePath){Start-Process $guidePath} })
$artemisDownload.Add_Click({
    if (-not $DryRun) {
        try {
            Set-Clipboard -Value ([string]$lock.artemis.apkUrl)
            $status.Text = 'Đã sao chép link tải Artemis. Hãy gửi link sang điện thoại hoặc quét QR.'
        }
        catch {
            $status.Text = 'Không sao chép được link Artemis. Hãy quét QR hoặc mở hướng dẫn để tải.'
        }
    }
})
$showIp.Add_Click({
    if (-not $DryRun -and (Test-Path -LiteralPath $ipHelperPath)) {
        Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$ipHelperPath`""
    }
})
$performance.Add_Click({
    $browser=Selected-Browser; if(-not $browser){$status.Text='Chưa tìm thấy trình duyệt để tạo shortcut.';return}
    try { [void](New-PhwgnaPerformanceShortcut -Browser $browser -DryRun:$DryRun); $status.Text=[Regex]::Unescape('\u0110\u00e3 t\u1ea1o shortcut t\u0103ng t\u1ed1c tr\u00ean Desktop.') }
    catch { $status.Text=[Regex]::Unescape('Kh\u00f4ng t\u1ea1o \u0111\u01b0\u1ee3c shortcut t\u0103ng t\u1ed1c. Shortcut ri\u00eang c\u1ee7a b\u1ea1n kh\u00f4ng b\u1ecb ghi \u0111\u00e8.') }
})
$install.Add_Click({
    $install.Enabled=$false
    try {
        if ($pcMode.Checked) {
            if (-not $DryRun) { Start-Process $installPageUrl }
            $status.Text='Đã mở trang cài Phwgna Stv. Bản Chrome Web Store sẽ được Chrome tự cập nhật.'
        }
        else {
            $status.Text='Đang kiểm tra và cài Sunshine. Windows có thể hỏi quyền một lần...'
            $status.Refresh()
            [Windows.Forms.Application]::DoEvents()
            $sunshine = Install-PhwgnaSunshineIfMissing -Lock $lock -DryRun:$DryRun
            if (-not $sunshine.ok) {
                if ($sunshine.code -eq 'service_not_running') {
                    $status.Text=[Regex]::Unescape('Sunshine \u0111\u00e3 c\u00e0i nh\u01b0ng ch\u01b0a ch\u1ea1y. H\u00e3y m\u1edf Sunshine t\u1eeb menu Start r\u1ed3i th\u1eed l\u1ea1i.')
                } else {
                    $status.Text="Không cài được Sunshine an toàn. Không có file chưa xác minh nào được chạy. Code: $($sunshine.code)"
                    if(-not $DryRun){Start-Process ([string]$lock.sunshine.releaseUrl)}
                }
                return
            }
            $tail = Install-PhwgnaTailscaleIfSelected -Selected $tailscale.Checked -Lock $lock -DryRun:$DryRun
            if (-not $tail.ok -and $tail.guideUrl -and -not $DryRun) { Start-Process ([string]$tail.guideUrl); $status.Text='Tailscale cần cài thủ công. Trang hướng dẫn chính thức đã được mở.' }
            else {
                $ip=Get-PhwgnaLanAddress
                if ($ip) {
                    try { Set-Clipboard -Value $ip } catch { }
                    $status.Text="Sunshine đã sẵn sàng. Trang tạo tài khoản Sunshine và trang cài extension sẽ mở; đây là hai bước cần bạn xác nhận thủ công.`r`nIP cùng Wi-Fi: $ip (đã sao chép)"
                } else {
                    $status.Text='Sunshine đã sẵn sàng. Hãy bấm “Lấy IP kết nối” sau khi PC đã vào Wi-Fi.'
                }
            }
            if (-not $DryRun) { Start-Process 'https://localhost:47990'; Start-Process $installPageUrl }
        }
    } catch { $status.Text="Không thể hoàn tất bước chuẩn bị. Code: $($_.Exception.Message)" }
    finally { $install.Enabled=$browsers.Count -gt 0 }
})

Update-WizardMode
[void]$form.ShowDialog()
