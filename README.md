# EOLO Access Bridge

Servicio local para operar accesos EOLO desde una LAN. Incluye panel de operador, integracion EOLO Cloud/Bubble, auditoria local de eventos, lectura de identificaciones, reconocimiento peatonal, ANPR/RTSP, puertas/barreras y empaquetado instalable con Electron.

## Funciones incluidas

- Panel de operador en `http://localhost:8080` para login EOLO, seleccion de acceso/punto de control, movimientos, eventos y ajustes.
- Seccion `Eventos` para auditoria local de detecciones y operaciones de puerta, con busqueda, rango de fechas, filtros y metricas.
- Creacion automatica de eventos locales cuando el operador registra movimientos desde el panel de Movimientos.
- Seccion `Peatones` para administrar dispositivos locales de reconocimiento facial y permisos peatonales descargados desde EOLO Cloud.
- Soporte multi-dispositivo para lectores faciales `Hikvision Mini Moe` y `Dahua ASI`, cada uno con configuracion, prueba de comunicacion, carga de usuarios y escucha de eventos.
- Seccion `Vehiculos` para camaras ANPR, permisos vehiculares, estado de API ANPR, streams RTSP activos y ajustes del procesador ANPR.
- Seccion `Puertas y Barreras` para configurar barreras/puertas locales. El tipo disponible por ahora es `Hikvision ISAPI`.
- Seccion `Visualizador RTC` para revisar el servicio de visualizacion en tiempo real.
- Seccion `Lectura de Identificaciones` para elegir camara local y configurar OpenAI Vision para extraer datos de una identificacion. La API key efectiva se resuelve por acceso activo (`Acceso.AuxKey1`) y cae a la key local si el acceso no tiene valor.
- Seccion `Sincronizacion` con tabs `Cloud`, `Permisos` y `Dispositivos`.
- Descarga de `PermisoAccesos` via Bubble Data API para el acceso activo, filtrando desde Cloud por `VigenciaFinal` futura y despues localmente por tipo de entidad.
- Snapshot local de permisos en `data/operator-access-permissions.json`.
- Snapshot para carga a dispositivos faciales en `data/eolo-users-snapshot.json`, generado desde permisos peatonales activos.
- Logs persistidos en `data/logs.jsonl`, consultables desde `/settings > Logs`; al hacer clic en el ultimo log se abre su detalle.
- Autenticacion Digest fresca por peticion para equipos Hikvision/Dahua cuando aplica.
- Modo `MOCK_DEVICE=true` para desarrollo sin dispositivo.
- API local para que EOLO envie tareas, ejecute polling o consulte estado operativo.

## Arranque local

```bash
cp .env.example .env
npm install
npm run dev
```

Abre:

- Operador: `http://localhost:8080`
- Ajustes: `http://localhost:8080/settings` o desde el menu de perfil del Operador > Ajustes

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
release\EOLO Access Bridge Setup 0.2.10.exe
```

El instalador macOS queda en:

```text
release/EOLO Access Bridge-0.2.10-arm64.dmg
```

Notas:

- El build Windows debe ejecutarse en Windows porque PyInstaller necesita binarios nativos de OpenCV/PyTorch/onnxruntime.
- El equipo operativo solo necesita el instalador generado; no necesita Docker, Node ni Python.
- Los datos locales quedan fuera de la app instalada:
  - Windows: `%APPDATA%\EOLO Access Bridge`
  - macOS: `~/Library/Application Support/EOLO Access Bridge`

### Actualizaciones Windows asistidas

La app instalable consulta un manifiesto remoto cada 6 horas y tambien desde el menu:

```text
EOLO Access Bridge > Buscar actualizaciones
```

Por defecto consulta:

```text
https://raw.githubusercontent.com/joqr231210/EOLO-Access-Bridge/main/updates/windows-latest.json
```

Si el manifiesto publica una version mayor, la app ofrece descargar el instalador, valida SHA-256 si viene incluido, y al elegir **Instalar ahora** cierra Bridge/ANPR de forma ordenada antes de abrir el setup.

Para publicar una actualizacion despues de generar el instalador Windows y subirlo a GitHub Releases:

```powershell
npm version patch --no-git-tag-version
npm run desktop:win:full
npm run updates:win-manifest -- "release\EOLO Access Bridge Setup X.Y.Z.exe" "https://URL-publica/EOLO%20Access%20Bridge%20Setup%20X.Y.Z.exe"
git add package.json package-lock.json updates/windows-latest.json
git commit -m "Release EOLO Access Bridge X.Y.Z"
git push
```

No actualices `updates/windows-latest.json` hasta tener la URL publica final del `.exe`; el script calcula el SHA-256 del instalador real.

En pilotos privados puedes apuntar a otro manifiesto antes de abrir la app:

```powershell
setx EOLO_DESKTOP_UPDATE_MANIFEST_URL "https://tu-dominio/updates/windows-latest.json"
```

## Arranque con Docker

```bash
cp .env.example .env
docker compose up -d --build
```

Windows limpio con Docker Desktop instalado:

```powershell
cd $env:USERPROFILE\Downloads
powershell -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri https://gist.githubusercontent.com/joqr231210/30692d997dcf49a183da9c37e3ad2016/raw/run-eolo-access-bridge-docker.ps1 -OutFile run-eolo-access-bridge-docker.ps1"
powershell -ExecutionPolicy Bypass -File .\run-eolo-access-bridge-docker.ps1
```

El script descarga `eoloapp/eolo-access-bridge:all-in-one-latest` para `linux/amd64`, reemplaza el contenedor existente y arranca Bridge, ANPR y WebRTC con puertos/volumenes persistentes. Si algo falla, deja la ventana abierta con diagnostico y sugerencias.

Si Docker Hub responde `authentication required`, inicia sesion y vuelve a ejecutar el script:

```powershell
docker login
```

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

## Datos locales importantes

- `data/device-config.json`: configuracion runtime de Bridge, EOLO Cloud, dispositivos faciales, camaras y servicios.
- `data/operator-access-permissions.json`: ultimo snapshot local de `PermisoAccesos` descargado desde Bubble Data API para el acceso activo. Solo conserva permisos con `VigenciaFinal` posterior al momento de descarga.
- `data/eolo-users-snapshot.json`: snapshot derivado para cargar a dispositivos faciales. Solo incluye permisos peatonales/persona activos y usa `NombrePrincipal` como nombre y `ImagenRostro` como rostro.
- `data/logs.jsonl`: bitacora persistida, visible en `/settings > Logs`.
- `data/events.jsonl`: eventos locales de auditoria, visibles en `Eventos`.
- `data/operator-pending-movements.json`: movimientos creados offline pendientes de sincronizar.
- `uploads/`: imagenes temporales o adjuntas por el operador.

`PermisoAccesos` se consulta una vez por acceso activo con constraint Data API `vigenciafinal_date > ahora`; despues se filtra localmente para las vistas `Peatones`, `Vehiculos` y `Sincronizacion > Permisos`. La descarga automatica de permisos la ejecuta `EoloUserSync` cada `EOLO_USER_SYNC_INTERVAL_MINUTES` minutos, por defecto 30. El intervalo `EOLO_OPERATOR_SYNC_INTERVAL_MINUTES` de 5 minutos es independiente y corresponde al refresco general del panel operador.

La lectura de identificaciones usa OpenAI Vision con prioridad por acceso:

1. si el acceso activo trae `AuxKey1`, Bridge usa esa API key;
2. si `AuxKey1` esta vacio, Bridge usa la API key local guardada en Ajustes;
3. `/settings > Lectura de Identificaciones` muestra si la key efectiva viene de `Acceso` o de `Local`.

## API principal

Salud, servicios y configuracion:

- `GET /api/health`
- `GET /api/services`
- `POST /api/services/:id/start|stop|restart`
- `GET /api/device-config`
- `PUT /api/device-config`
- `POST /api/device-config/test`

Dispositivos faciales y empleados:

- `GET /api/face-devices`
- `POST /api/face-devices`
- `PUT /api/face-devices/:id`
- `DELETE /api/face-devices/:id`
- `POST /api/face-devices/:id/test`
- `POST /api/face-devices/:id/stream/start`
- `POST /api/face-devices/:id/stream/stop`
- `POST /api/face-devices/:id/sync-device`
- `GET /api/employees`
- `POST /api/employees`
- `PUT /api/employees/:employeeNo`
- `DELETE /api/employees/:employeeNo`
- `POST /api/employees/:employeeNo/face`

Sincronizacion EOLO:

- `GET /api/eolo/users-sync/status`
- `POST /api/eolo/users-sync/cloud-download`
- `POST /api/eolo/users-sync/device-apply`
- `POST /api/eolo/users-sync/run`
- `POST /api/eolo/tasks`
- `POST /api/eolo/tasks/poll`

ANPR, eventos y logs:

- `GET /api/anpr/dashboard`
- `GET /api/anpr/hardware`
- `PUT /api/anpr/hardware`
- `GET /api/anpr/config`
- `PUT /api/anpr/config`
- `POST /api/anpr/barriers/:id/open`
- `POST /api/anpr/sync-now`
- `GET /api/events`
- `GET /api/events/stream`
- `GET /api/logs`

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
