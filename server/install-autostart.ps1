# Makes the dubbing server start by itself when you log in.
#
# Without this the server has to be started by hand every time the machine
# reboots, and the extension simply reports that it cannot reach it.
#
#   .\install-autostart.ps1            install and start now
#   .\install-autostart.ps1 -Remove    uninstall
#   .\install-autostart.ps1 -Status    show what is currently registered

[CmdletBinding()]
param(
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$taskName = 'YouTubePersianDubber-Server'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $root 'start-hidden.vbs'

function Get-Task {
    Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

if ($Status) {
    $task = Get-Task
    if ($task) {
        Write-Host "registered: $taskName" -ForegroundColor Green
        Write-Host "  state   : $($task.State)"
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        Write-Host "  last run: $($info.LastRunTime)  (result $($info.LastTaskResult))"
    }
    else {
        Write-Host "not registered" -ForegroundColor Yellow
    }
    $listening = Get-NetTCPConnection -LocalPort 8760 -State Listen -ErrorAction SilentlyContinue
    if ($listening) { Write-Host "port 8760: listening" -ForegroundColor Green }
    else { Write-Host "port 8760: nothing listening" -ForegroundColor Yellow }
    exit 0
}

if ($Remove) {
    if (Get-Task) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "removed $taskName" -ForegroundColor Green
    }
    else {
        Write-Host "nothing to remove"
    }
    Get-NetTCPConnection -LocalPort 8760 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    exit 0
}

if (-not (Test-Path $launcher)) {
    Write-Host "start-hidden.vbs is missing next to this script." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $root '.venv'))) {
    Write-Host "No virtual environment yet. Run run.ps1 -Setup first." -ForegroundColor Red
    exit 1
}

if (Get-Task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Runs only while this user is logged in, with no elevation: a local helper
# should never need more rights than the person using it.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Local Piper speech server for the YouTube Persian Dubber extension.' | Out-Null

Write-Host "registered $taskName (runs at logon)" -ForegroundColor Green

Get-NetTCPConnection -LocalPort 8760 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

Start-ScheduledTask -TaskName $taskName
Write-Host "starting now..." -NoNewline

for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:8760/health' -TimeoutSec 2
        Write-Host " up, $($health.voices.Count) voice(s)." -ForegroundColor Green
        Write-Host "to undo: .\install-autostart.ps1 -Remove"
        exit 0
    }
    catch { }
}

Write-Host ""
Write-Host "did not answer within 10s. Run .\run.ps1 to see the error." -ForegroundColor Yellow
exit 1
