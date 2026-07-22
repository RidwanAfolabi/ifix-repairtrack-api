# Production login smoke test.
#
# Prompts for the password with Read-Host -AsSecureString so it never appears
# in the terminal, PSReadLine history, or a process listing.
#
#   powershell -File scripts/smoke-login.ps1
#   powershell -File scripts/smoke-login.ps1 -Email someone@ifixexpress.com.my

param(
  [string]$Email = 'repairtrack-admin@ifixexpress.com.my',
  [string]$BaseUrl = 'https://api.ifixexpress.com.my'
)

$secure = Read-Host "Password for $Email" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
)

$body = @{ email = $Email; password = $plain } | ConvertTo-Json

try {
  $res = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/auth/login" `
    -ContentType 'application/json' -Body $body
} catch {
  Write-Host "`nLOGIN FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "If this says 401, the password is wrong or the account is inactive." -ForegroundColor Yellow
  exit 1
} finally {
  $plain = $null
  [GC]::Collect()
}

Write-Host "`nLOGIN OK" -ForegroundColor Green
Write-Host "  Name   : $($res.staff.name)"
Write-Host "  Role   : $($res.staff.role)"
Write-Host "  Branch : $($res.staff.branch_name) (id $($res.staff.branch_id))"
Write-Host "  Expires: $([DateTimeOffset]::FromUnixTimeSeconds($res.expires_at).ToLocalTime())"

$auth = @{ Authorization = "Bearer $($res.token)" }

# Exercise the admin-only route the account will actually use.
Write-Host "`nChecking admin routes..."
foreach ($path in '/api/staff', '/api/branches', '/api/jobs') {
  try {
    $r = Invoke-WebRequest -Uri "$BaseUrl$path" -Headers $auth -UseBasicParsing
    Write-Host "  $path -> $($r.StatusCode)" -ForegroundColor Green
  } catch {
    Write-Host "  $path -> $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
  }
}

Write-Host "`nIf all three returned 200, production auth is working end to end." -ForegroundColor Cyan
