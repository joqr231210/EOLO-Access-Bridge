$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$AnprDir = Join-Path $RootDir "AnprEolo"
$VenvDir = Join-Path $RootDir ".venv-anpr"

if ($env:PYTHON) {
  $PythonBin = $env:PYTHON
} else {
  $PythonBin = "py"
}

if (-not (Test-Path $VenvDir)) {
  if ($PythonBin -eq "py") {
    & py -3.11 -m venv $VenvDir
  } else {
    & $PythonBin -m venv $VenvDir
  }
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$PyInstaller = Join-Path $VenvDir "Scripts\pyinstaller.exe"

& $VenvPython -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { throw "No se pudieron actualizar las herramientas de Python." }
& $VenvPython -m pip install -r (Join-Path $AnprDir "requirements.txt") pyinstaller
if ($LASTEXITCODE -ne 0) { throw "No se pudieron instalar las dependencias ANPR." }
& $VenvPython (Join-Path $RootDir "scripts\verify-anpr-assets.py")
if ($LASTEXITCODE -ne 0) { throw "No se pudieron verificar los modelos ANPR." }

Push-Location $AnprDir
try {
  & $PyInstaller --clean --noconfirm anpr-sidecar.spec
  if ($LASTEXITCODE -ne 0) { throw "No se pudo compilar el sidecar ANPR." }
} finally {
  Pop-Location
}

$OutputDir = Join-Path $RootDir "dist"
$TargetDir = Join-Path $OutputDir "anpr-eolo"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
if (Test-Path $TargetDir) {
  Remove-Item -Recurse -Force $TargetDir
}
Copy-Item -Recurse -Force (Join-Path $AnprDir "dist\anpr-eolo") $TargetDir

Write-Host "ANPR sidecar listo en $TargetDir"
