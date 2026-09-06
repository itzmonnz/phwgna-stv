$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'phwgna-setup-core.ps1')

$text = ConvertFrom-Json '["IP k\u1ebft n\u1ed1i Sunshine","C\u00f9ng Wi-Fi - d\u00e1n IP n\u00e0y v\u00e0o Artemis:","\u0110\u00e3 t\u1ef1 sao ch\u00e9p IP v\u00e0o clipboard. Trong Artemis, ch\u1ecdn th\u00eam m\u00e1y t\u00ednh r\u1ed3i D\u00c1N.","Ngo\u00e0i m\u1ea1ng nh\u00e0 qua Tailscale - d\u00f9ng IP n\u00e0y thay th\u1ebf:","Kh\u00f4ng t\u00ecm th\u1ea5y IP Wi-Fi/LAN. H\u00e3y k\u1ebft n\u1ed1i Wi-Fi tr\u00ean PC r\u1ed3i ch\u1ea1y l\u1ea1i file n\u00e0y."]'

Write-Host ''
Write-Host "=== $($text[0]) ===" -ForegroundColor Cyan
$lanAddress = Get-PhwgnaLanAddress
if (-not $lanAddress) {
    Write-Host $text[4] -ForegroundColor Yellow
    exit 1
}

Write-Host ''
Write-Host $text[1]
Write-Host "  $lanAddress" -ForegroundColor Green
try {
    Set-Clipboard -Value $lanAddress
    Write-Host $text[2] -ForegroundColor Green
} catch {
    Write-Host 'Hay boi den IP o tren va nhan Ctrl+C.' -ForegroundColor Yellow
}

$tailscaleAddress = Get-PhwgnaTailscaleAddress
if ($tailscaleAddress) {
    Write-Host ''
    Write-Host $text[3]
    Write-Host "  $tailscaleAddress" -ForegroundColor Cyan
}
