# ============================================================
# deploy.ps1 — Recipro: แก้โค้ด -> GitHub -> Railway (คำสั่งเดียวจบ)
# โดเมน www.recipro.love ผูกไว้แล้ว ไม่ต้องทำอะไรเพิ่ม
#
# วิธีใช้:
#   .\deploy.ps1 "ข้อความ commit"     # commit+push การแก้ไข แล้ว deploy
#   .\deploy.ps1                        # ไม่มีข้อความ = ใช้ timestamp อัตโนมัติ
#
# ต้องล็อกอินไว้ก่อน (ทำครั้งเดียว):
#   gh auth switch --user edenharvestdev     # บัญชีที่มีสิทธิ์ push
#   railway login                            # บัญชี edenharvest.dev@gmail.com
# ============================================================
param([string]$Message = "")

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ให้แน่ใจว่า railway/gh อยู่ใน PATH (เผื่อหน้าต่างเปิดก่อนติดตั้ง)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + `
            [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "==> 1/3 ตรวจการแก้ไข + commit/push ขึ้น GitHub" -ForegroundColor Cyan
$changes = git status --porcelain
if ($changes) {
    if (-not $Message) { $Message = "update $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
    git add -A
    git commit -m $Message
    git push origin main
    Write-Host "    pushed: $Message" -ForegroundColor DarkGray
} else {
    Write-Host "    ไม่มีการแก้ไขใหม่ — ข้าม commit/push" -ForegroundColor DarkGray
}

Write-Host "==> 2/3 deploy ขึ้น Railway (service: recipro-app)" -ForegroundColor Cyan
railway up --service recipro-app --detach

Write-Host "==> 3/3 เสร็จ — ดูสถานะ: railway logs   |   เปิด: https://www.recipro.love" -ForegroundColor Green
