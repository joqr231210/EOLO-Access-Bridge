# EOLO Hikvision Local

Servicio local para operar un terminal Hikvision ISAPI desde una LAN y sincronizar eventos/tareas con EOLO.

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

Abre `http://localhost:8080`.

## Arranque con Docker

```bash
cp .env.example .env
docker compose up -d --build
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
