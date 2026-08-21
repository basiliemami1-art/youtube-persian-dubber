# Sets up (once) and starts the local dubbing server.
#
#   .\run.ps1              start the server, creating .venv and fetching a voice if needed
#   .\run.ps1 -Setup       only do the setup, do not start
#   .\run.ps1 -Port 9000   listen somewhere else
#   .\run.ps1 -Translator ollama -OllamaModel qwen2.5:7b

[CmdletBinding()]
param(
    [switch]$Setup,
    [int]$Port = 8760,
    [ValidateSet('auto', 'ollama', 'argos', 'none')]
    [string]$Translator = 'auto',
    [string]$OllamaModel = 'qwen2.5:7b'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $root '.venv'
$python = Join-Path $venv 'Scripts\python.exe'

function Resolve-SystemPython {
    foreach ($candidate in @('py', 'python3', 'python')) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $command) { continue }
        # The Microsoft Store alias is a stub that exits without doing anything.
        if ($command.Source -like '*WindowsApps*') {
            $probe = & $command.Source '--version' 2>&1
            if ($LASTEXITCODE -ne 0) { continue }
        }
        return $command.Source
    }
    return $null
}

if (-not (Test-Path $python)) {
    $systemPython = Resolve-SystemPython
    if (-not $systemPython) {
        Write-Host 'Python 3.9+ was not found.' -ForegroundColor Red
        Write-Host 'Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".'
        exit 1
    }

    Write-Host "creating virtual environment with $systemPython" -ForegroundColor Cyan
    & $systemPython -m venv $venv
    if ($LASTEXITCODE -ne 0) { Write-Host 'venv creation failed' -ForegroundColor Red; exit 1 }

    Write-Host 'installing dependencies (this pulls in onnxruntime, a few hundred MB)' -ForegroundColor Cyan
    & $python -m pip install --upgrade pip --quiet
    & $python -m pip install -r (Join-Path $root 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { Write-Host 'pip install failed' -ForegroundColor Red; exit 1 }
}

$models = Join-Path $root 'models'
$hasVoice = (Test-Path $models) -and ((Get-ChildItem -Path $models -Filter '*.onnx' -ErrorAction SilentlyContinue).Count -gt 0)

if (-not $hasVoice) {
    Write-Host 'no Piper voice installed yet, downloading one' -ForegroundColor Cyan
    & $python (Join-Path $root 'download_models.py')
}

if ($Setup) {
    Write-Host 'setup complete.' -ForegroundColor Green
    exit 0
}

Write-Host "starting server on http://127.0.0.1:$Port" -ForegroundColor Green
& $python (Join-Path $root 'server.py') `
    --port $Port `
    --translator $Translator `
    --ollama-model $OllamaModel
