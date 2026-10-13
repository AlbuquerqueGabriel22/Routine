$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $projectRoot "backend"
$pythonExe = Join-Path $projectRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $pythonExe)) {
    throw "Ambiente Python não encontrado. Crie .venv e instale backend\requirements-desktop.txt primeiro."
}

Push-Location $backendDir
try {
    & $pythonExe -m PyInstaller `
        --noconfirm `
        --clean `
        --onedir `
        --name routiner-api `
        --collect-all fastapi `
        --collect-all starlette `
        --collect-all pydantic `
        --collect-all uvicorn `
        --collect-all python_multipart `
        desktop_server.py
    if ($LASTEXITCODE -ne 0) {
        throw "O empacotamento da API com PyInstaller falhou (código $LASTEXITCODE)."
    }
} finally {
    Pop-Location
}
