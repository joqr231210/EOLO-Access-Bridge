# Estatus para retomar - EOLO Access Bridge / Hikvision Local

Fecha de corte: 2026-07-31  
Proyecto: servicio local EOLO Access Bridge para terminal Hikvision ISAPI  
Ruta de trabajo:

```text
/Users/joqr231210/Documents/Codex/2026-07-16/he/work/eolo-hikvision-local
```

Ruta de entregables:

```text
/Users/joqr231210/Documents/Codex/2026-07-16/he/outputs
```

## 1. Objetivo del proyecto

Crear un servicio local, portable en Docker, que corra dentro de la LAN y conecte:

- la nube EOLO;
- un dispositivo Hikvision de control de acceso/reconocimiento facial;
- una UI local web en puerto `8080`.

La llave principal de sincronizacion con el dispositivo es `employeeNo`.

Para registros sincronizados desde EOLO, el `employeeNo` local usa el `_id` unico de EOLO, por ejemplo:

```text
1776097830299x944639891097256000
```

Los empleados locales con IDs simples se preservan durante la sincronizacion EOLO.

## 2. Arquitectura

```text
EOLO nube
  |
  | HTTP GET permisos/acceso-residentes
  | Bearer token
  | query params: acceso, dispositivo
  v
Servicio local EOLO Access Bridge
  |
  | Hikvision ISAPI
  | HTTP Digest Authentication
  v
Terminal Hikvision en LAN
```

El servicio local tiene:

- backend/API Node.js;
- frontend web estatico;
- persistencia en archivos locales;
- modo real contra Hikvision;
- modo mock para desarrollo sin dispositivo;
- Dockerfile y Docker Compose.

## 3. Tecnologias usadas

- Node.js con ES Modules.
- Express para API HTTP y servir la UI.
- `digest-fetch` para HTTP Digest Authentication.
- `multer` para recibir imagenes desde la UI.
- Multipart manual para carga facial a Hikvision.
- Server-Sent Events para logs/eventos en vivo hacia el frontend.
- Archivos JSON/JSONL para persistencia simple.
- Docker y Docker Compose para despliegue local portable.

## 4. Estructura relevante

```text
work/eolo-hikvision-local/
  src/
    server.js              API local y servidor web
    hikvisionClient.js     Cliente ISAPI Hikvision
    eventStream.js         Lectura/parseo de alertStream
    runtimeConfig.js       Configuracion persistida
    logger.js              Logs/eventos JSONL + SSE
    eoloClient.js          Cliente HTTP EOLO
    eoloUserSync.js        Sincronizacion de usuarios EOLO
    taskRunner.js          Ejecucion opcional de tareas EOLO
    mockDevice.js          Simulador local
  public/
    index.html             UI
    app.js                 Interacciones frontend
    styles.css             Estilos
  data/
    device-config.json     Configuracion runtime
    logs.jsonl             Logs persistidos
    events.jsonl           Eventos persistidos
  uploads/                 Imagenes temporales/subidas
  Dockerfile
  docker-compose.yml
  .env.example
  README.md
```

## 5. Configuracion

La configuracion inicial puede venir de `.env`; la UI puede sobrescribirla y guardarla en:

```text
data/device-config.json
```

Campos importantes:

- `MOCK_DEVICE`
- `BRIDGE_IDENTIFIER`
- `LOCAL_DEVICE_ID`
- `HIKVISION_HOST`
- `HIKVISION_PORT`
- `HIKVISION_PROTOCOL`
- `HIKVISION_USERNAME`
- `HIKVISION_PASSWORD`
- `HIKVISION_DOOR_NO`
- `HIKVISION_PLAN_TEMPLATE_NO`
- `HIKVISION_FDID`
- `HIKVISION_FACE_LIB_TYPE`
- `HIKVISION_DEDUP_WINDOW_SECONDS`
- `EOLO_API_TOKEN`
- `EOLO_USER_SYNC_ENABLED`
- `EOLO_USER_SYNC_ENDPOINT`
- `EOLO_ACCESS`
- `EOLO_USER_SYNC_INTERVAL_MINUTES`

La API publica de configuracion no expone secretos; muestra `passwordSet` y `tokenSet`.

## 6. Endpoints Hikvision utilizados

Validados o integrados:

- `GET /ISAPI/System/deviceInfo`
- `GET /ISAPI/System/capabilities`
- `POST /ISAPI/AccessControl/UserInfo/Record?format=json`
- `PUT /ISAPI/AccessControl/UserInfo/Modify?format=json`
- `PUT /ISAPI/AccessControl/UserInfo/Delete?format=json`
- `POST /ISAPI/AccessControl/UserInfo/Search?format=json`
- `POST /ISAPI/Intelligent/FDLib/FaceDataRecord?format=json`
- `GET /ISAPI/Event/notification/alertStream`

Notas tecnicas importantes:

- Digest se crea fresco por peticion, para comportarse como `curl --digest`.
- Las fechas de usuarios se generan en hora local `YYYY-MM-DDTHH:mm:ss`.
- La carga facial usa multipart manual con `FaceDataRecord`, `FaceImage`, boundary y `Content-Length`.
- El listado de empleados se sanitiza para no exponer el campo `password` que algunos Hikvision devuelven.

## 7. Funcionalidad actual

### Configuracion

La vista Configuracion esta separada por tabs:

- `Dispositivo Local`
- `Sincronizacion EOLO`

Dispositivo Local permite:

- editar IP/host, puerto, protocolo, usuario y contrasena;
- editar puerta, plan, FDID, libreria facial y dedupe;
- configurar nombre del bridge e ID local;
- probar conexion contra `deviceInfo`;
- guardar y validar.

Sincronizacion EOLO permite:

- configurar endpoint EOLO;
- configurar token Bearer;
- configurar `acceso`;
- configurar intervalo;
- activar/desactivar sincronizacion;
- sincronizar manualmente.

### Empleados

La vista Empleados tiene:

- Directorio con listado desde `UserInfo/Search`.
- Busqueda por ID empleado.
- Paginacion visual de 12 en 12.
- Alta manual de empleado.
- Edicion desde modal.
- Baja desde modal de confirmacion.
- Actualizacion de rostro dentro del modal Editar empleado.

La actualizacion de rostro dentro del modal:

- tiene tab propio;
- precarga el ID empleado;
- mantiene el ID readonly para evitar cargar rostro en otro usuario.

### Eventos y logs

La vista Eventos esta separada en tabs:

- `Eventos dispositivo`
- `Logs`

Eventos dispositivo:

- muestra eventos recibidos del Hikvision;
- permite abrir el JSON raw de cada evento;
- el raw se despliega con animacion.

Logs:

- muestra logs tecnicos del backend;
- tambien muestra mensajes de Comandos como fuente `UI`;
- sirve como linea temporal unica de acciones humanas y comunicacion tecnica.

Barra superior:

- muestra el ultimo log;
- tiene dot verde/rojo/ambar segun estado;
- anima cuando cambia;
- al hacer clic abre el tab Logs y posiciona el registro.

### Comandos

La vista Comandos sigue funcionando como consola/bitacora visual de acciones de usuario.

Todo lo visible en Comandos tambien se replica en Logs como fuente `UI`.

### EOLO sync

La sincronizacion EOLO usa:

- endpoint configurable;
- query param `acceso`;
- query param `dispositivo`, tomado de `LOCAL_DEVICE_ID`;
- token Bearer;
- respuesta esperada con `acceso-residentes`.

Formato esperado:

```json
{
  "status": "success",
  "response": {
    "acceso-residentes": [
      {
        "_id": "1776097830299x944639891097256000",
        "Nombre": "NOMBRE USUARIO",
        "Imagen": "//cdn.bubble.io/ruta/imagen.jpg",
        "deleted": false
      }
    ]
  }
}
```

Reglas actuales:

- Solo sincroniza IDs EOLO con formato `numeros x numeros`.
- `employeeNo` local = `_id`.
- `name` local = `Nombre`.
- Si el registro trae `Imagen`, intenta cargar rostro.
- Si un empleado EOLO ya no existe en nube, se elimina del dispositivo.
- Los empleados locales sin formato EOLO se preservan.

## 8. API local principal

- `GET /api/health`
- `GET /api/device-info`
- `GET /api/device-config`
- `PUT /api/device-config`
- `POST /api/device-config/test`
- `GET /api/employees`
- `POST /api/employees`
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

## 9. Validaciones realizadas

Validado contra dispositivo real Hikvision:

- `deviceInfo`.
- Alta de empleado.
- Modificacion de empleado.
- Baja de empleado.
- Listado/busqueda de empleados con `UserInfo/Search`.
- Carga de rostro desde UI/API.
- Stream/recepcion de eventos.
- Visualizacion de eventos y raw JSON.
- Logs en vivo.
- Modales de edicion/baja.
- Actualizacion de rostro desde modal de editar empleado.

Validaciones tecnicas:

- `node --check` sobre archivos principales.
- `npm audit --omit=dev` sin vulnerabilidades.
- `docker compose config` valido.

Docker:

- `Dockerfile` existe.
- `docker-compose.yml` existe.
- `HEALTHCHECK` contra `/api/health`.
- Volumenes persistentes:
  - `./data:/app/data`
  - `./uploads:/app/uploads`

Pendiente historico:

- En una validacion previa no se pudo ejecutar `docker build` porque el daemon Docker local no estaba corriendo.

## 10. Uso local

Desde la carpeta:

```text
/Users/joqr231210/Documents/Codex/2026-07-16/he/work/eolo-hikvision-local
```

Arranque de desarrollo:

```bash
cp .env.example .env
npm install
npm run dev
```

Abrir:

```text
http://localhost:8080
```

Comandos utiles:

```bash
npm audit --omit=dev
node --check src/server.js
node --check public/app.js
curl -s http://localhost:8080/api/health
curl -s http://localhost:8080/api/device-config
```

## 11. Uso con Docker

Desde `work/eolo-hikvision-local`:

```bash
cp .env.example .env
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs -f eolo-access-bridge
```

Para detener:

```bash
docker compose down
```

Para reiniciar:

```bash
docker compose restart eolo-access-bridge
```

Healthcheck:

```bash
docker inspect --format='{{json .State.Health}}' eolo-access-bridge
```

## 12. Observaciones conocidas

- Si Hikvision responde `deviceUserAlreadyExistFace`, significa que el rostro ya existe para ese empleado. Puede requerirse flujo especifico de reemplazo/borrado de rostro antes de subir uno nuevo.
- Algunas URLs de imagen EOLO pueden fallar si el formato/tamano/headers no son compatibles con el dispositivo.
- `alertStream` depende del firmware/configuracion del equipo; si falla, revisar endpoint o permisos del dispositivo.
- La carpeta de trabajo actual no es un repositorio git.
- Conviene agregar autenticacion local antes de exponer esta UI en una red compartida.

## 13. Siguientes pasos recomendados

1. Implementar reemplazo de rostro cuando ya existe rostro en Hikvision.
2. Agregar autenticacion local para proteger UI/API.
3. Completar paginacion real del directorio contra `UserInfo/Search`.
4. Versionar imagen Docker y documentar instalacion para cliente.
5. Definir contrato final de envio de eventos hacia EOLO.
6. Agregar pruebas automatizadas para normalizadores EOLO y payloads Hikvision.
7. Revisar politica de retencion de `logs.jsonl`, `events.jsonl` y `uploads`.

## 14. Archivos de resumen relacionados

Resumen de arquitectura existente:

```text
/Users/joqr231210/Documents/Codex/2026-07-16/he/outputs/resumen-arquitectura-eolo-hikvision.md
```

Este handoff:

```text
/Users/joqr231210/Documents/Codex/2026-07-16/he/outputs/estatus-retomar-eolo-access-bridge-2026-07-31.md
```
