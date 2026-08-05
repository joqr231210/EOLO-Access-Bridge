# Estatus para retomar - EOLO Access Bridge

Fecha original de corte: 2026-07-31
Ultima actualizacion: 2026-08-05
Proyecto: servicio local EOLO Access Bridge con Hikvision, ANPR y sincronizacion EOLO Cloud
Ruta actual de trabajo:

```text
/Users/joqr231210/Documents/EOLO-Access-Bridge
```

## 1. Objetivo actual

Construir un servicio local portable en Docker que corra dentro de la LAN y concentre en una misma interfaz:

- Face Recognition con terminal Hikvision ISAPI.
- Sincronizacion de residentes/empleados desde EOLO Cloud hacia Hikvision.
- Control y monitoreo local de ANPR.
- Registro local de visitas/accesos.
- Sincronizacion de visitas/accesos hacia EOLO Cloud.
- Administracion de camaras RTSP y barreras ISAPI asociadas.

El proyecto ya no es solo "Hikvision Local"; ahora es un bridge local para accesos. Lo de estacionamientos/cobros fue retirado u ocultado de la UI y del flujo operativo relevante.

## 2. Arquitectura actual

```text
EOLO Cloud
  |
  | HTTP API / Bubble endpoints
  v
EOLO Access Bridge (Node/Express, puerto 8080)
  |
  | ISAPI / Digest Auth
  v
Terminal Hikvision Face Recognition

EOLO Access Bridge
  |
  | HTTP interno: http://anpr-api:8090
  v
AnprEolo (Python/Flask/Gunicorn)
  |
  | RTSP / YOLO / OCR / SQLite
  v
Camaras RTSP + barreras ISAPI + base local de accesos
```

Docker Compose levanta dos contenedores:

- `eolo-access-bridge`: Node/Express + frontend en `http://localhost:8080`.
- `eolo-anpr-api`: API interna Python de `AnprEolo`, expuesta solo dentro de Compose como `anpr-api:8090`.

Volumenes importantes:

- `./data:/app/data`
- `./uploads:/app/uploads`
- `./AnprEolo/plates.db:/app/data/plates.db`
- `./AnprEolo/config.json:/app/data/config.json`
- `./AnprEolo/static/captures:/app/static/captures`

## 3. Tecnologias principales

- Node.js con ES Modules.
- Express para API Bridge y UI local.
- `digest-fetch` para Hikvision ISAPI con Digest Auth.
- Server-Sent Events para logs/eventos en vivo.
- JSON/JSONL para configuracion y logs Bridge.
- Python/Flask/Gunicorn para `AnprEolo`.
- SQLite para datos locales ANPR.
- RTSP + OpenCV + YOLO + OCR en el procesador ANPR.
- Docker Compose para correr Bridge + ANPR juntos.

## 4. Estructura relevante

```text
EOLO-Access-Bridge/
  src/
    server.js              API local Bridge, proxy ANPR y servidor web
    hikvisionClient.js     Cliente ISAPI Hikvision
    eventStream.js         Lectura/parseo de alertStream
    runtimeConfig.js       Configuracion persistida Bridge
    logger.js              Logs/eventos JSONL + SSE
    eoloClient.js          Cliente HTTP EOLO
    eoloUserSync.js        Sincronizacion residentes/empleados EOLO
    taskRunner.js          Polling de tareas EOLO
  public/
    index.html             UI
    app.js                 Interacciones frontend
    styles.css             Estilos
  data/
    device-config.json     Configuracion runtime Bridge
    logs.jsonl             Logs persistidos
    events.jsonl           Eventos persistidos
  uploads/                 Imagenes temporales/subidas
  AnprEolo/
    web_config.py          API Flask, control de servicios ANPR y endpoints config/hardware
    app.py                 Procesador ANPR
    config.json            Configuracion ANPR montada en Docker
    plates.db              SQLite local
    stream/                Preview RTSP
  docs/
    estatus-retomar-eolo-access-bridge-2026-07-31.md
  Dockerfile
  docker-compose.yml
  .env.example
```

## 5. Servicios en la UI

La UI principal esta organizada en `Servicios` con submenu lateral. Estado y nombres actuales:

- `Face Recognition`
- `Residentes Sync`
- `Tareas Pooling`
- `Local API ANPR`
- `Procesador ANPR`
- `Barreras`
- `Visualizador Camaras`
- `Visitas Sync`

Notas UI recientes:

- El menu `Eventos` del sidebar esta oculto.
- El card `Ultima Comunicacion` del sidebar esta oculto.
- El header superior "Servicio local EOLO" fue removido.
- El toggle `Escuchar Eventos Dispositivo` se movio a `Face Recognition > Operacion`, porque pertenece al stream de eventos Hikvision.
- Cada submenu activo filtra la superficie principal para mostrar solo lo relativo a ese servicio.

## 6. Face Recognition

`Face Recognition` concentra lo relacionado con Hikvision.

Tabs internos:

- `Operacion`
- `Empleados`

`Operacion` muestra:

- estado del stream de eventos del dispositivo;
- toggle para escuchar/detener eventos Hikvision;
- dispositivo/host/modo;
- registro reciente de eventos.

`Empleados` integra la vista completa de empleados:

- Directorio con listado desde `UserInfo/Search`.
- Busqueda por ID empleado.
- Paginacion visual.
- Alta manual.
- Edicion desde modal.
- Baja desde modal.
- Actualizacion de rostro dentro del modal.

Endpoints Hikvision usados:

- `GET /ISAPI/System/deviceInfo`
- `GET /ISAPI/System/capabilities`
- `POST /ISAPI/AccessControl/UserInfo/Record?format=json`
- `PUT /ISAPI/AccessControl/UserInfo/Modify?format=json`
- `PUT /ISAPI/AccessControl/UserInfo/Delete?format=json`
- `POST /ISAPI/AccessControl/UserInfo/Search?format=json`
- `POST /ISAPI/Intelligent/FDLib/FaceDataRecord?format=json`
- `GET /ISAPI/Event/notification/alertStream`

La llave principal de sincronizacion con el dispositivo sigue siendo `employeeNo`.

## 7. Residentes Sync y Tareas Pooling

`Residentes Sync`:

- Sincroniza residentes/empleados desde EOLO Cloud hacia Hikvision.
- Usa token Bearer, `acceso` y `dispositivo`.
- Preserva empleados locales que no tienen formato EOLO.
- Puede ejecutarse manualmente desde su vista.

`Tareas Pooling`:

- Consulta tareas EOLO para el agente local.
- Expone control de polling y ejecucion manual.

## 8. ANPR integrado

`AnprEolo` fue integrado como servicio interno controlado por Bridge.

Servicios ANPR visibles:

- `Local API ANPR`: salud y configuracion general de la API Python.
- `Procesador ANPR`: proceso que lee camaras RTSP, detecta vehiculos/placas, registra movimientos y abre barreras.
- `Barreras`: CRUD de barreras ISAPI.
- `Visualizador Camaras`: preview/servidor interno RTSP.
- `Visitas Sync`: sincronizacion de movimientos de acceso hacia EOLO Cloud.

### Procesador ANPR

Tabs internos:

- `Resumen`
- `Camaras`
- `Movimientos`

`Resumen` muestra:

- estado del proceso;
- PID;
- cantidad de camaras;
- cantidad de barreras;
- movimientos;
- pendientes de sincronizacion;
- controles iniciar/detener/reiniciar.

`Camaras` incluye:

- formulario de parametros ANPR;
- editor de camaras RTSP;
- asociacion de una camara con una o varias barreras registradas.

Parametros editables desde `Procesador ANPR > Camaras`:

- `server_url` / Server ANPR;
- `version` Bubble (`test`/`live`);
- `id_acceso`;
- `bubble_token` (si se deja vacio no se borra el token existente);
- `min_plate_width_ratio`;
- `min_plate_height_ratio`;
- `require_vehicle_detection`;
- `min_vehicle_confidence`.

Al guardar camaras o parametros, el cambio queda en `AnprEolo/config.json`. Si el procesador ya esta corriendo, conviene reiniciar `Procesador ANPR` para asegurar que tome camaras nuevas o cambios de configuracion inicial.

`Movimientos` muestra movimientos locales de acceso desde SQLite.

### Barreras

`Barreras` es una vista al mismo nivel de `Procesador ANPR`.

Permite:

- crear barreras ISAPI;
- modificar barreras;
- borrar barreras.

Al iniciar la configuracion base solo hay una barrera demo:

```json
{
  "id_barra": "demo-barrier",
  "numero_barra": "1",
  "ip_puerto": "192.168.1.10:80",
  "usuario": "admin",
  "password": "",
  "camera_name": ""
}
```

Relacion actual:

- La relacion nueva vive en la camara como `barrier_ids`.
- Una camara puede activar una o varias barreras.
- El procesador conserva compatibilidad con la relacion legacy `barrier.camera_name`.

### Visualizador Camaras

Quedo separado de la edicion de camaras. Ahora sirve para:

- controlar preview RTSP;
- consultar camaras disponibles.

La creacion/modificacion de camaras vive en `Procesador ANPR > Camaras`.

### Visitas Sync

`Visitas Sync` sincroniza accesos/visitas locales hacia EOLO Cloud.

Se removio del flujo de este proyecto lo asociado a estacionamientos/cobros:

- `GET /movimientos_cero?estacionamiento=<id_estacionamiento>`
- `POST /apk_salida_reserva`
- `GET /inventario_estacionamiento?estacionamiento=<id_estacionamiento>`

La app actual es para accesos, no estacionamientos.

## 9. Endpoints Bridge relevantes

Principales:

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
- `GET /api/events`
- `GET /api/events/stream`
- `POST /api/device/stream/start`
- `POST /api/device/stream/stop`
- `GET /api/services`
- `POST /api/services/:serviceId/start`
- `POST /api/services/:serviceId/stop`
- `POST /api/services/:serviceId/restart`

EOLO:

- `GET /api/eolo/users-sync/status`
- `POST /api/eolo/users-sync/run`
- `POST /api/eolo/tasks/poll`

ANPR proxied por Bridge:

- `GET /api/anpr/dashboard`
- `GET /api/anpr/hardware`
- `PUT /api/anpr/hardware`
- `GET /api/anpr/config`
- `PUT /api/anpr/config`
- `POST /api/anpr/barriers/:id/open`
- `POST /api/anpr/sync-now`

## 10. Endpoints internos AnprEolo relevantes

La API Python corre internamente en `8090` dentro del contenedor `anpr-api`.

- `GET /api/health`
- `GET /api/services`
- `GET /api/dashboard`
- `GET /api/hardware`
- `PUT /api/hardware`
- `GET /api/config`
- `PUT /api/config`
- `POST /api/services/<service_id>/<action>`
- `POST /api/sync_now`
- `POST /open/<id_barra>`

`GET/PUT /api/config` fue agregado para editar parametros ANPR desde la UI Bridge.

## 11. Configuracion

Bridge:

- `.env` puede inicializar configuracion.
- La UI guarda runtime en `data/device-config.json`.
- La API publica de configuracion no expone secretos; muestra banderas como `passwordSet`/`tokenSet`.

Campos Bridge importantes:

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
- `ANPR_API_BASE_URL`

ANPR:

- `AnprEolo/config.json` se monta como `/app/data/config.json`.
- `AnprEolo/plates.db` se monta como `/app/data/plates.db`.
- `server_url`, `bubble_token`, filtros de placa/vehiculo, camaras y barreras se editan desde `Procesador ANPR > Camaras` y `Barreras`.

## 12. Estado local observado el 2026-08-05

Docker Compose:

```text
eolo-access-bridge   healthy   0.0.0.0:8080->8080/tcp
eolo-anpr-api        healthy   8090 interno, 8083 interno
```

Servicios reportados por `/api/services` durante la ultima verificacion:

```text
hikvision-events    Face Recognition       stopped
eolo-users-sync     Residentes Sync        stopped
eolo-task-poller    Tareas Pooling         stopped
anpr-api            Local API ANPR         running
anpr-processor      Procesador ANPR        running
barriers            Barreras               ready
rtsp-preview        Visualizador Camaras   stopped
visit-sync          Visitas Sync           running
```

Configuracion ANPR observada:

```json
{
  "server_url": "https://hkdk.events/4epjjkrnir4k7n",
  "version": "live",
  "bubble_token_set": true,
  "min_plate_width_ratio": 0.02,
  "min_plate_height_ratio": 0.02,
  "require_vehicle_detection": true,
  "min_vehicle_confidence": 0.78
}
```

Hardware ANPR observado:

```json
{
  "cameras": [
    {
      "name": "CASA",
      "rtsp": "rtsp://***:***@192.168.1.74:554/stream1",
      "type": "Salida",
      "prefix": "CAS",
      "barrier_ids": ["demo-barrier"]
    }
  ],
  "barriers": [
    {
      "id_barra": "demo-barrier",
      "numero_barra": "1",
      "ip_puerto": "192.168.1.10:80",
      "usuario": "admin",
      "password": "",
      "camera_name": ""
    }
  ]
}
```

Nota: el RTSP real en `config.json` puede contener credenciales en claro. En este documento queda enmascarado; evitar compartir el archivo de configuracion fuera del entorno de desarrollo.

## 13. Validaciones recientes

Ejecutadas durante la integracion:

```bash
node --check public/app.js
node --check src/server.js
python3 -m py_compile AnprEolo/app.py AnprEolo/web_config.py
docker compose config --quiet
docker compose up -d --build
curl -s http://localhost:8080/api/services
curl -s http://localhost:8080/api/anpr/hardware
curl -s http://localhost:8080/api/anpr/config
```

Tambien se valido visualmente en navegador integrado:

- sidebar de servicios;
- `Face Recognition > Operacion`;
- `Face Recognition > Empleados`;
- `Procesador ANPR > Resumen`;
- `Procesador ANPR > Camaras`;
- `Procesador ANPR > Movimientos`;
- `Barreras`;
- `Visualizador Camaras`.

## 14. Uso local

Desde:

```text
/Users/joqr231210/Documents/EOLO-Access-Bridge
```

Arranque con Docker:

```bash
docker compose up -d --build
docker compose ps
```

Abrir:

```text
http://localhost:8080
```

Comandos utiles:

```bash
node --check src/server.js
node --check public/app.js
python3 -m py_compile AnprEolo/app.py AnprEolo/web_config.py
docker compose config --quiet
curl -s http://localhost:8080/api/health
curl -s http://localhost:8080/api/services
curl -s http://localhost:8080/api/anpr/dashboard
curl -s http://localhost:8080/api/anpr/hardware
curl -s http://localhost:8080/api/anpr/config
```

Para detener:

```bash
docker compose down
```

Para reiniciar:

```bash
docker compose restart eolo-access-bridge anpr-api
```

## 15. Commits recientes importantes

```text
2a51486 feat: edit anpr detection settings in cameras tab
fd463e8 chore: move device event toggle into face recognition
eb8d4fd feat: split anpr cameras and barriers views
a4636a5 feat: embed employees in face recognition service
cbd76f7 chore: remove parking from visit sync ui
c32815c feat: add anpr hardware editor
35d814b feat: add nested services navigation
1020cc3 chore: hide visit charge sync from bridge ui
db0b27b feat: add service-specific operations tabs
c3d06fa fix: preserve anpr cloud config defaults in compose
fe7e147 feat: add service control plane for bridge and anpr
e88a0b8 chore: establish bridge integration baseline
```

## 16. Estado git y nota importante sobre AnprEolo

El repo raiz `EOLO-Access-Bridge` contiene los commits Bridge recientes.

`AnprEolo` es un repo anidado y esta dirty con cambios necesarios para la integracion, ademas de cambios previos que ya existian. No se ha hecho commit dentro de `AnprEolo` para evitar mezclar historial.

Cambios relevantes actuales dentro de `AnprEolo`:

- `app.py`
- `web_config.py`
- `config.json`

Puntos funcionales introducidos ahi:

- soporte de `barrier_ids` en camaras;
- apertura de multiples barreras por camara;
- default de barrera demo cuando no existe campo `barriers`;
- endpoints `GET/PUT /api/config`;
- preservacion de token Bubble si no se envia nuevo token desde la UI;
- retiro del flujo operativo de estacionamientos/cobros.

Antes de entregar formalmente conviene decidir si:

1. Se commitea `AnprEolo` como repo independiente.
2. Se absorbe `AnprEolo` dentro del repo raiz.
3. Se declara submodulo/subtree con version fija.

## 17. Pendientes y riesgos

- Reinicio necesario: si se agregan camaras RTSP nuevas o se cambian parametros de arranque, reiniciar `Procesador ANPR` para asegurar que lea la configuracion.
- Seguridad: la UI local aun no tiene autenticacion propia. No exponerla fuera de una LAN confiable.
- Secretos: `AnprEolo/config.json` puede contener RTSP y tokens. Evitar commitear secretos reales.
- Reemplazo de rostro Hikvision: si el dispositivo responde `deviceUserAlreadyExistFace`, puede requerirse flujo especifico de reemplazo/borrado.
- Paginacion real: el directorio de empleados usa paginacion visual; revisar paginacion contra `UserInfo/Search` si crece mucho.
- Pruebas automatizadas: faltan tests para normalizadores EOLO, payloads Hikvision y payloads ANPR.
- Retencion: definir politica para `logs.jsonl`, `events.jsonl`, capturas ANPR y `uploads`.
- Contrato EOLO final: confirmar endpoints definitivos para visitas/accesos y tareas del agente local.

## 18. Siguiente paso recomendado

Antes de seguir agregando funciones:

1. Regularizar `AnprEolo` en git.
2. Validar con una camara RTSP real que `Procesador ANPR` detecta vehiculos/placas.
3. Validar apertura real de una barrera ISAPI desde `Barreras`.
4. Probar flujo completo: placa detectada -> movimiento local -> barrera -> sync a EOLO Cloud.
5. Decidir autenticacion local minima para proteger la UI.
