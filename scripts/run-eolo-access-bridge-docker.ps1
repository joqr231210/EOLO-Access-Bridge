param(
  [string]$Image = "eoloapp/eolo-access-bridge:all-in-one-latest",
  [string]$Platform = "linux/amd64",
  [string]$ContainerName = "eolo-access-bridge",
  [int]$BridgePort = 8080,
  [int]$PreviewPort = 8083,
  [int]$AnprPort = 8090,
  [int]$WebRtcPort = 1984,
  [int]$WebRtcMediaPort = 8555,
  [string]$DataVolume = "eolo_access_data",
  [string]$UploadsVolume = "eolo_access_uploads",
  [int]$HealthTimeoutSeconds = 90,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Message)
  Write-Host "OK  $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "AVISO  $Message" -ForegroundColor Yellow
}

function Fail {
  param(
    [string]$Message,
    [string[]]$Hints = @()
  )
  Write-Host ""
  Write-Host "ERROR  $Message" -ForegroundColor Red
  foreach ($hint in $Hints) {
    Write-Host "  - $hint" -ForegroundColor Yellow
  }
  throw $Message
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "No se encontro '$Name'." @(
      "Instala Docker Desktop: https://www.docker.com/products/docker-desktop/",
      "Cierra y abre de nuevo PowerShell despues de instalar Docker Desktop."
    )
  }
}

function Invoke-Logged {
  param(
    [string]$Label,
    [scriptblock]$Command,
    [string[]]$Hints = @()
  )
  Write-Step $Label
  $output = & $Command 2>&1
  $exitCode = $LASTEXITCODE
  if ($output) {
    $output | ForEach-Object { Write-Host $_ }
  }
  if ($exitCode -ne 0) {
    Fail "$Label fallo con codigo $exitCode." $Hints
  }
  return $output
}

function Get-ContainerId {
  param([string]$Name)
  $id = docker ps -aq --filter "name=^/$Name$" 2>$null
  if ($LASTEXITCODE -ne 0) { return "" }
  return ($id | Select-Object -First 1)
}

function Remove-ExistingContainer {
  param([string]$Name)
  $id = Get-ContainerId $Name
  if ($id) {
    Write-Step "Reemplazando contenedor existente '$Name'"
    docker rm -f $Name | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Fail "No se pudo reemplazar el contenedor existente '$Name'." @(
        "Abre Docker Desktop y deten el contenedor manualmente.",
        "Luego vuelve a ejecutar este script."
      )
    }
    Write-Ok "Contenedor anterior eliminado."
  }
}

function Test-PortAvailable {
  param([int]$Port)
  $inUse = $false
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    $listener.Stop()
  } catch {
    $inUse = $true
  }
  return (-not $inUse)
}

function Assert-PortsAvailable {
  param([int[]]$Ports)
  Write-Step "Validando puertos locales"
  $busy = @()
  foreach ($port in $Ports) {
    if (-not (Test-PortAvailable $port)) {
      $busy += $port
    }
  }
  if ($busy.Count -gt 0) {
    Fail "Hay puertos ocupados: $($busy -join ', ')." @(
      "Cierra la aplicacion que usa esos puertos o cambia los parametros del script.",
      "Ejemplo: powershell -ExecutionPolicy Bypass -File .\run-eolo-access-bridge-docker.ps1 -BridgePort 18080"
    )
  }
  Write-Ok "Puertos disponibles: $($Ports -join ', ')."
}

function Wait-ContainerHealthy {
  param(
    [string]$Name,
    [int]$TimeoutSeconds
  )
  Write-Step "Esperando que el contenedor quede listo"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $state = docker inspect $Name --format "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}" 2>$null
    if ($LASTEXITCODE -eq 0 -and $state) {
      $parts = $state -split "\|"
      $status = $parts[0]
      $health = $parts[1]
      if ($status -ne "running") {
        break
      }
      if ($health -eq "healthy" -or $health -eq "no-healthcheck") {
        Write-Ok "Contenedor listo: status=$status health=$health."
        return
      }
      Write-Host "  status=$status health=$health ..."
    }
    Start-Sleep -Seconds 3
  }

  Write-Host ""
  Write-Host "Ultimos logs del contenedor:" -ForegroundColor Yellow
  docker logs --tail 80 $Name 2>&1 | ForEach-Object { Write-Host $_ }
  Fail "El contenedor no quedo healthy dentro de $TimeoutSeconds segundos." @(
    "Revisa Docker Desktop > Containers > $Name.",
    "Tambien puedes ejecutar: docker logs -f $Name"
  )
}

function Test-BridgeHttp {
  param([int]$Port)
  Write-Step "Validando HTTP local"
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 10
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
      Write-Ok "Bridge responde en http://localhost:$Port."
      return
    }
    Fail "Bridge respondio HTTP $($response.StatusCode)." @("Ejecuta: docker logs -f $ContainerName")
  } catch {
    Fail "No se pudo consultar http://localhost:$Port/api/health." @(
      "Espera unos segundos y abre http://localhost:$Port.",
      "Si no abre, ejecuta: docker logs -f $ContainerName"
    )
  }
}

function Main {
  Write-Host ""
  Write-Host "EOLO Access Bridge - instalador Docker Windows" -ForegroundColor Cyan
  Write-Host "Imagen:      $Image"
  Write-Host "Plataforma:  $Platform"
  Write-Host "Contenedor:  $ContainerName"
  Write-Host ""

  Assert-Command "docker"

  Invoke-Logged -Label "Verificando Docker Desktop" -Command {
    docker version
  } -Hints @(
    "Abre Docker Desktop y espera a que diga que Docker esta corriendo.",
    "Si es la primera vez, acepta la instalacion de WSL2 cuando Docker lo solicite."
  ) | Out-Null

  Remove-ExistingContainer $ContainerName
  Assert-PortsAvailable @($BridgePort, $PreviewPort, $AnprPort, $WebRtcPort, $WebRtcMediaPort)

  Invoke-Logged -Label "Descargando ultima imagen" -Command {
    docker pull --platform $Platform $Image
  } -Hints @(
    "Si aparece 'authentication required', ejecuta: docker login",
    "Confirma que el repo/imagen exista: $Image",
    "Si tu red bloquea Docker Hub, prueba otra red o VPN."
  ) | Out-Null

  Invoke-Logged -Label "Creando volumenes persistentes" -Command {
    docker volume create $DataVolume
    docker volume create $UploadsVolume
  } -Hints @("Verifica que Docker Desktop tenga permisos suficientes.") | Out-Null

  Invoke-Logged -Label "Arrancando EOLO Access Bridge" -Command {
    docker run --platform $Platform -d `
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
      $Image
  } -Hints @(
    "Si un puerto esta ocupado, vuelve a ejecutar cambiando el puerto.",
    "Ejemplo: -BridgePort 18080 -PreviewPort 18083"
  ) | Out-Null

  Wait-ContainerHealthy $ContainerName $HealthTimeoutSeconds
  Test-BridgeHttp $BridgePort

  Write-Host ""
  Write-Host "LISTO" -ForegroundColor Green
  Write-Host "  Operador: http://localhost:$BridgePort"
  Write-Host "  Ajustes:  http://localhost:$BridgePort/settings"
  Write-Host ""
  Write-Host "Comandos utiles:" -ForegroundColor Cyan
  Write-Host "  docker logs -f $ContainerName"
  Write-Host "  docker ps --filter name=$ContainerName"
  Write-Host "  docker rm -f $ContainerName"
}

$failed = $false
try {
  Main
} catch {
  $failed = $true
  Write-Host ""
  Write-Host "No se pudo completar la instalacion/arranque." -ForegroundColor Red
  Write-Host "Detalle: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
  Write-Host "Diagnostico rapido:" -ForegroundColor Cyan
  try {
    docker ps -a --filter "name=$ContainerName" 2>$null | ForEach-Object { Write-Host $_ }
  } catch {
    Write-Warn "No fue posible consultar Docker."
  }
} finally {
  Write-Host ""
  if ($failed) {
    Write-Host "La ventana se queda abierta para que puedas leer el error." -ForegroundColor Yellow
  }
  if (-not $NoPause) {
    Read-Host "Presiona Enter para cerrar"
  }
}
