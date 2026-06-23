# ============================================================
# backup-db.ps1 — สำรองฐานข้อมูล Recipro production (Railway Postgres)
#
# วิธีรัน (ดึง connection จาก Railway โดยไม่ต้องพิมพ์รหัสเอง):
#   railway link            # ครั้งแรก: เลือกโปรเจกต์ recipro / production
#   railway run --service Postgres -- powershell -ExecutionPolicy Bypass -File backup-db.ps1
#
# หรือถ้ามี public URL อยู่แล้ว:
#   $env:DATABASE_PUBLIC_URL = "<postgresql://...>"; .\backup-db.ps1
#
# หมายเหตุสำคัญ: prod ใช้ PostgreSQL 18 → ต้องมี pg_dump เวอร์ชัน >= 18
#   ถ้ามีแค่ PG17 ให้ติดตั้ง client 18:  winget install PostgreSQL.PostgreSQL.18
#   (หรือใช้ Railway dashboard → service Postgres → แท็บ Backups แทนได้เลย)
# ============================================================
$ErrorActionPreference = 'Stop'

$url = if ($env:DATABASE_PUBLIC_URL) { $env:DATABASE_PUBLIC_URL } elseif ($env:DATABASE_URL) { $env:DATABASE_URL } else { $null }
if (-not $url) {
  Write-Error "ไม่พบ DATABASE_PUBLIC_URL/DATABASE_URL ใน env — รันผ่าน: railway run --service Postgres -- powershell -File backup-db.ps1"
  exit 1
}

# หา pg_dump เวอร์ชันสูงสุดที่ติดตั้ง
$dump = $null; $ver = 0
foreach ($v in 20,19,18,17,16) {
  $p = "C:\Program Files\PostgreSQL\$v\bin\pg_dump.exe"
  if (Test-Path $p) { $dump = $p; $ver = $v; break }
}
if (-not $dump) { Write-Error "ไม่พบ pg_dump — ติดตั้ง PostgreSQL client ก่อน"; exit 1 }
if ($ver -lt 18) {
  Write-Warning "pg_dump เป็น PG$ver แต่ prod เป็น PG18 — อาจ dump ไม่ได้. แนะนำ: winget install PostgreSQL.PostgreSQL.18 หรือใช้ Railway dashboard Backups"
}

$dir = Join-Path $PSScriptRoot '..\backups'
New-Item -ItemType Directory -Force $dir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$out = Join-Path $dir "recipro-prod-db-$stamp.sql"

Write-Host "กำลังดัมพ์ด้วย pg_dump PG$ver -> $out ..." -ForegroundColor Cyan
& $dump --no-owner --no-acl --clean --if-exists "$url" -f $out
$kb = [math]::Round((Get-Item $out).Length / 1KB, 0)
Write-Host "เสร็จ: $out ($kb KB)" -ForegroundColor Green
