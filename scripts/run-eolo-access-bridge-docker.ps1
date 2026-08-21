param(
  [string]$Image = "eoloapp/eolo-access-bridge:0.2.4-all-in-one-amd64",
  [string]$ContainerName = "eolo-access-bridge",
  [int]$BridgePort = 8080,
  [int]$PreviewPort = 8083,
  [int]$AnprPort = 8090,
  [int]$WebRtcPort = 1984,
  [int]$WebRtcMediaPort = 8555,
  [string]$DataVolume = "eolo_access_data",
  [string]$UploadsVolume = "eolo_access_uploads",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"

function Main {
  Assert-Command "docker"

  Write-Host ""
  Write-Host "EOLO Access Bridge - Docker all-in-one" -ForegroundColor Cyan
  Write-Host "Imagen: $Image"
  Write-Host "Contenedor: $ContainerName"
  Write-Host ""

  Write-Host "Verificando Docker..." -ForegroundColor Cyan
  docker version | Out-Null

  Write-Host "Descargando imagen..." -ForegroundColor Cyan
  docker pull $Image

  $existingContainer = docker ps -aq --filter "name=^/$ContainerName$"
  if ($existingContainer) {
    Write-Host "Deteniendo/remplazando contenedor existente..." -ForegroundColor Yellow
    docker rm -f $ContainerName | Out-Null
  }

  Write-Host "Creando volumenes persistentes..." -ForegroundColor Cyan
  docker volume create $DataVolume | Out-Null
  docker volume create $UploadsVolume | Out-Null

  Write-Host "Arrancando EOLO Access Bridge..." -ForegroundColor Cyan
  docker run -d `
    --name $ContainerName `
    -p "${BridgePort}:8080" `
    -p "${PreviewPort}:8083" `
    -p "${AnprPort}:8090" `
    -p "${WebRtcPort}:1984" `
    -p "${WebRtcMediaPort}:8555" `
    -p "${WebRtcMediaPort}:8555/udp" `
    -e "ANPR_STREAM_PUBLIC_URL=http://localhost:$PreviewPort" `
    -e "ANPR_WEBRTC_PUBLIC_URL=http://localhost:$WebRtcPort" `
    -e "ANPR_WEBRTC_ICE_HOST=localhost" `
    -e "ANPR_WEBRTC_AUTOSTART=true" `
    -v "${DataVolume}:/app/data" `
    -v "${UploadsVolume}:/app/uploads" `
    --restart unless-stopped `
    $Image | Out-Null

  Write-Host ""
  Write-Host "Listo. Abre:" -ForegroundColor Green
  Write-Host "  Operador: http://localhost:$BridgePort"
  Write-Host "  Ajustes:  http://localhost:$BridgePort/settings"
  Write-Host ""
  Write-Host "Comandos utiles:" -ForegroundColor Cyan
  Write-Host "  docker logs -f $ContainerName"
  Write-Host "  docker ps --filter name=$ContainerName"
  Write-Host "  docker rm -f $ContainerName"
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "No se encontro '$Name'. Instala Docker Desktop y vuelve a ejecutar este script."
  }
}

try {
  Main
} catch {
  Write-Host ""
  Write-Host "No se pudo arrancar EOLO Access Bridge." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ""
  Write-Host "Si el error dice 'authentication required', ejecuta primero:" -ForegroundColor Yellow
  Write-Host "  docker login"
  Write-Host "y vuelve a correr este script."
  Write-Host ""
  Write-Host "Si Docker Desktop no esta abierto, abre Docker Desktop y espera a que indique 'Docker is running'."
  exit 1
} finally {
  if (-not $NoPause) {
    Write-Host ""
    Read-Host "Presiona Enter para cerrar"
  }
}
