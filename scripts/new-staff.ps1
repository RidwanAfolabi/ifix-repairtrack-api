# Create a staff account, or reset an existing account's password.
#
# Prompts for the password with Read-Host -AsSecureString and pipes it to
# hash-password.mjs over stdin, so the password never appears in argv, in
# PSReadLine history, or in a process listing — and is never subject to
# PowerShell's '$' / backtick substitution.
#
#   Create : powershell -File scripts/new-staff.ps1
#   Reset  : powershell -File scripts/new-staff.ps1 -Reset -Email admin@ifixexpress.com.my

param(
  [switch]$Reset,
  [string]$Email,
  [string]$Name,
  [int]$Branch = 1,
  [ValidateSet('admin', 'technician', 'staff')]
  [string]$Role = 'staff'
)

if (-not $Email) { $Email = Read-Host 'Email' }
if (-not $Reset -and -not $Name) { $Name = Read-Host 'Full name' }

$secure = Read-Host 'Password (min 10 chars)' -AsSecureString
$confirm = Read-Host 'Confirm password      ' -AsSecureString

$toPlain = {
  param($s)
  [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  )
}

$p1 = & $toPlain $secure
$p2 = & $toPlain $confirm

if ($p1 -ne $p2) {
  Write-Host "`nPasswords do not match." -ForegroundColor Red
  exit 1
}
if ($p1.Length -lt 10) {
  Write-Host "`nPassword must be at least 10 characters." -ForegroundColor Red
  exit 1
}

# Build args WITHOUT the password — it goes over stdin only.
$nodeArgs = @('scripts/hash-password.mjs', '--email', $Email)
if ($Reset) {
  $nodeArgs += '--update'
} else {
  $nodeArgs += @('--name', $Name, '--branch', "$Branch", '--role', $Role)
}

# Write-Output pipes the string to node's stdin.
$p1 | & node @nodeArgs

$p1 = $null; $p2 = $null
[GC]::Collect()
