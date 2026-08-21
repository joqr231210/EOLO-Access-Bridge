# EOLO Access Bridge

Servicio local para operar accesos EOLO desde una LAN. Incluye panel de operador, integracion EOLO Cloud, captura local de fotos, ANPR/RTSP y empaquetado instalable con Electron.

## Funciones incluidas

- Alta, modificacion y baja de empleados usando `employeeNo` como llave comun con EOLO.
- Directorio de empleados mediante `UserInfo/Search`, con edicion, actualizacion de rostro y baja desde modales.
- Carga de rostro por imagen JPEG/PNG hacia `FDLib/FaceDataRecord`.
- Multipart facial armado de forma explicita con `FaceDataRecord`, `FaceImage`, boundary y `Content-Length`.
- Autenticacion Digest fresca por peticion, alineada con el comportamiento de `curl --digest`.
- JSON de usuario con fechas locales `YYYY-MM-DDTHH:mm:ss`.
- Lectura continua de eventos desde `alertStream`.
- Vista Eventos separada en tabs de eventos del dispositivo y logs.
- Despliegue animado del JSON raw de cada evento desde la vista Eventos para investigacion.
- Dedupe por `serialNo` y por empleado dentro de una ventana configurable.
- Visor web en `http://localhost:8080` con estilo tipo ChatGPT.
- Barra superior con el ultimo log de comunicacion visible en todo momento.
- Animacion y dot de color en el ultimo log cuando cambia el estado.
- Clic en el ultimo log para abrir la vista de Logs y posicionar el registro exacto.
- Los mensajes visibles en Comandos tambien se reflejan en Logs como fuente `UI`.
- Seccion de empleados separada por tabs para registro y actualizacion de rostro.
- Configuracion web de IP, puerto, protocolo, usuario, contrasena y parametros ISAPI.
- Sincronizacion configurable de usuarios EOLO desde `acceso-residentes` hacia empleados Hikvision.
- IDs locales simples se conservan; IDs sincronizados EOLO usan el `_id` de nube, por ejemplo `1776097830299x944639891097256000`.
- En cada sincronizacion se eliminan empleados EOLO ausentes en nube, se crean/actualizan los presentes y se actualiza rostro si viene URL.
- Validacion inmediata contra `GET /ISAPI/System/deviceInfo` al guardar configuracion real.
- Modo `MOCK_DEVICE=true` para desarrollo sin dispositivo.
- API local para que EOLO envie tareas o para que el agente haga polling.

## Arranque local

```bash
cp .env.example .env
npm install
npm run dev
```

Abre:

- Operador: `http://localhost:8080`
- Ajustes tecnicos: `http://localhost:8080/settings`

## Instalador Electron con ANPR

macOS ARM64:

```bash
npm install
npm run desktop:mac:full
```

Windows x64, desde una maquina Windows con Git, Node.js LTS y Python 3.11:

```powershell
npm install
npm run desktop:win:full
```

El instalador Windows queda en:

```text
release\EOLO Access Bridge Setup 0.2.4.exe
```

El instalador macOS queda en:

```text
release/EOLO Access Bridge-0.2.4-arm64.dmg
```

Notas:

- El build Windows debe ejecutarse en Windows porque PyInstaller necesita binarios nativos de OpenCV/PyTorch/onnxruntime.
- El equipo operativo solo necesita el instalador generado; no necesita Docker, Node ni Python.
- Los datos locales quedan fuera de la app instalada:
  - Windows: `%APPDATA%\EOLO Access Bridge`
  - macOS: `~/Library/Application Support/EOLO Access Bridge`

## Arranque con Docker

```bash
cp .env.example .env
docker compose up -d --build
```

Windows limpio con Docker Desktop instalado:

```powershell
powershell -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri https://raw.githubusercontent.com/joqr231210/EOLO-Access-Bridge/main/scripts/run-eolo-access-bridge-docker.ps1 -OutFile run-eolo-access-bridge-docker.ps1"
powershell -ExecutionPolicy Bypass -File .\run-eolo-access-bridge-docker.ps1
```

El script descarga `eoloapp/eolo-access-bridge:all-in-one-latest`, reemplaza el contenedor existente y arranca Bridge, ANPR y WebRTC con puertos/volumenes persistentes.

Para conectar el equipo real, edita `.env`:

```env
HOST_PORT=8080
PORT=8080
MOCK_DEVICE=false
HIKVISION_HOST=192.168.1.77
BRIDGE_IDENTIFIER=Nuevo Dispositivo Bridge
LOCAL_DEVICE_ID=1784244113632x813567226617878100
HIKVISION_USERNAME=admin
HIKVISION_PASSWORD=tu-contrasena
EOLO_API_TOKEN=token-bearer
EOLO_USER_SYNC_ENABLED=true
EOLO_USER_SYNC_ENDPOINT=https://eolo.app/version-test/api/1.1/wf/permisos-acceso
EOLO_ACCESS=id-acceso
EOLO_USER_SYNC_INTERVAL_MINUTES=30
```

Compose fuerza dentro del contenedor `DATA_DIR=/app/data` y `UPLOAD_DIR=/app/uploads`, montados en las carpetas locales `./data` y `./uploads` para persistencia.

Comandos utiles de operacion:

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f eolo-access-bridge
docker compose restart eolo-access-bridge
docker compose down
```

El contenedor incluye `HEALTHCHECK` contra `/api/health`. Para revisar el estado:

```bash
docker inspect --format='{{json .State.Health}}' eolo-access-bridge
```

Respaldo minimo recomendado antes de actualizar:

```bash
mkdir -p backups
tar -czf backups/eolo-access-bridge-data-$(date +%Y%m%d-%H%M%S).tgz data uploads
```

## API principal

- `GET /api/health`
- `GET /api/device-info`
- `GET /api/device-config`
- `PUT /api/device-config`
- `POST /api/device-config/test`
- `POST /api/employees`
- `GET /api/employees`
- `PUT /api/employees/:employeeNo`
- `DELETE /api/employees/:employeeNo`
- `POST /api/employees/:employeeNo/face`
- `POST /api/eolo/tasks`
- `GET /api/eolo/users-sync/status`
- `POST /api/eolo/users-sync/run`
- `GET /api/events`
- `GET /api/events/stream`
- `POST /api/device/stream/start`
- `POST /api/device/stream/stop`

Ejemplo de tarea EOLO:

```json
{
  "id": "task-1001",
  "action": "upsertEmployee",
  "employee": {
    "employeeNo": "1001",
    "name": "Persona de prueba"
  }
}
```

Para rostro por API, usa `multipart/form-data` con el campo `face`.
