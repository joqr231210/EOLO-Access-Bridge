# Estatus para retomar - EOLO Access Bridge

Fecha original de corte: 2026-07-31
Ultima actualizacion: 2026-08-20 16:45 CST
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
  | RTSP / YOLO / OCR / SQLite / MSE preview
  v
Camaras RTSP + barreras ISAPI + base local de accesos
```

Docker Compose levanta dos contenedores:

- `eolo-access-bridge`: Node/Express + frontend en `http://localhost:8080`.
- `eolo-anpr-api`: API interna Python de `AnprEolo`, expuesta dentro de Compose como `anpr-api:8090`.

Puertos publicados:

- `8080`: Bridge + UI setup + UI operador.
- `8083`: visualizador RTSP/MSE de `AnprEolo/stream` para que el navegador pueda reproducir previews.

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
- RTSP a MSE/WebSocket para preview de camaras en navegador.
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
    operator.html          UI local de operador de acceso
    operator.js            Cliente operador, sesion, movimientos y camara ID
    operator.css           Estilos de la UI operador
    assets/                Imagenes y assets publicos de operador
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

El visualizador RTSP usa `AnprEolo/stream/rtsptomse` y publica player/websocket en el puerto `8083`. Docker Compose ahora publica ese puerto al host para que `/operator` pueda embeber los players en iframes compactos.

Variables relacionadas:

- `ANPR_STREAM_HOST_PORT=8083`
- `ANPR_STREAM_PUBLIC_URL=http://localhost:8083`
- `ANPR_DETECTIONS_FILE=/app/data/anpr-detections.json`
- `ANPR_STATUS_FILE=/app/data/anpr-status.json`

El procesador ANPR escribe:

- ultima lectura valida por camara en `anpr-detections.json`;
- telemetria por camara en `anpr-status.json`: captura activa, frames, predicciones, candidatos, intentos OCR, lecturas validas/rechazadas y ultimo error.

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
- `GET /api/anpr/detections`
- `GET /api/anpr/status`
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
- `GET /api/anpr/detections`
- `GET /api/anpr/status`
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
- `ANPR_STREAM_HOST_PORT`
- `ANPR_STREAM_PUBLIC_URL`

ANPR:

- `AnprEolo/config.json` se monta como `/app/data/config.json`.
- `AnprEolo/plates.db` se monta como `/app/data/plates.db`.
- El estado de lecturas/diagnostico ANPR se escribe en `/app/data/anpr-detections.json` y `/app/data/anpr-status.json`.
- `server_url`, `bubble_token`, filtros de placa/vehiculo, camaras y barreras se editan desde `Procesador ANPR > Camaras` y `Barreras`.

## 12. Estado local observado el 2026-08-10

Docker Compose:

```text
eolo-access-bridge   healthy   0.0.0.0:8080->8080/tcp
eolo-anpr-api        healthy   8090 interno, 0.0.0.0:8083->8083/tcp
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

Configuracion ANPR observada durante las ultimas pruebas:

```json
{
  "server_url": "https://hkdk.events/4epjjkrnir4k7n",
  "version": "live",
  "bubble_token_set": true,
  "min_plate_width_ratio": 0.001,
  "min_plate_height_ratio": 0.001,
  "require_vehicle_detection": true,
  "min_vehicle_confidence": 0.5
}
```

Hardware ANPR observado:

```json
{
  "cameras": [
    {
      "name": "DEMO",
      "rtsp": "rtsp://***:***@video.platerecognizer.com:8554/demo",
      "type": "Entrada",
      "prefix": "LFB",
      "barrier_ids": []
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

Diagnostico ANPR observado con stream demo:

```json
{
  "camera": "DEMO",
  "capture_running": true,
  "processing_running": true,
  "models_loaded": true,
  "frame_width": 1280,
  "frame_height": 720,
  "prediction_count": 316,
  "plate_candidate_count": 42,
  "ocr_attempt_count": 42,
  "valid_read_count": 0,
  "invalid_read_count": 42,
  "last_ocr_text": "34A23126"
}
```

El engine si recibe frames y ejecuta YOLO/OCR. La lectura demo `34A23126` fue rechazada por el validador actual porque el regex exige minimo 2 letras y 3 numeros. `34A23126` tiene una sola letra, por lo que no se publica como lectura valida ni aparece overlay. No se modifico el validador todavia.

## 13. Validaciones recientes

Ejecutadas durante la integracion:

```bash
node --check public/app.js
node --check public/operator.js
node --check src/server.js
python3 -m py_compile AnprEolo/app.py AnprEolo/web_config.py
docker compose config --quiet
docker compose up -d --build
curl -s http://localhost:8080/api/services
curl -s http://localhost:8080/api/anpr/hardware
curl -s http://localhost:8080/api/anpr/config
curl -s http://localhost:8080/operator
curl -s http://localhost:8080/operator.js
curl -s http://localhost:8080/operator.css
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

## 14. Vista Operador de Acceso

Durante la sesion del 2026-08-10 se agrego una UI separada para operador en:

```text
http://localhost:8080/operator
```

Esta vista queda separada de la UI original de setup/estacion de trabajo. El objetivo operativo es que un guardia u operador pueda iniciar sesion, elegir un acceso, elegir un punto de control obligatorio y administrar movimientos de acceso autorizados desde EOLO Cloud.

Archivos principales:

- `public/operator.html`
- `public/operator.css`
- `public/operator.js`
- `public/assets/eolo-login.jpg`
- `src/server.js`
- `src/config.js`
- `.env.example`

### Login operador

La vista de login quedo simplificada a PIN unicamente:

- Se elimino la opcion de iniciar sesion con SMS.
- Se elimino la opcion `Registrarme`.
- Se muestra el nombre `EOLO Access Bridge`.
- Se muestra version `v0.1.0`, tomada de `package.json`.
- El cliente envia siempre `mode: "pin"`.
- Se usa fondo publico `/assets/eolo-login.jpg`; el origen local usado fue `fondo-login.jpg` en la raiz del proyecto.
- El loader inicial se muestra desde el primer render y se oculta cuando termina la restauracion de sesion o se despliega el login.

El login Cloud usa el workflow Bubble `apk_login` en la rama configurada.

### Configuracion Bubble

La rama de trabajo de Bubble confirmada por Buildprint es:

```text
Proyecto Buildprint: Eolo
Bubble appId: parco
Dominio publico: eolo.app
Branch: acc-upd
Version id: 73hi5
Base workflow URL: https://eolo.app/version-73hi5/api/1.1/wf
```

La configuracion local permite cambiar facilmente entre branch y live:

```env
EOLO_OPERATOR_APP_BASE_URL=https://eolo.app
EOLO_OPERATOR_VERSION=73hi5
```

Para produccion, `EOLO_OPERATOR_VERSION` debe cambiarse a `live` cuando el cliente deba consumir la app live.

### Flujo de navegacion operador

Despues de iniciar sesion:

1. Se consultan los accesos autorizados para el usuario.
2. El usuario debe seleccionar un acceso.
3. Se consultan los puntos de control autorizados para ese usuario/acceso.
4. El usuario debe seleccionar un punto de control antes de entrar al panel principal.
5. El sidebar queda limitado para impedir saltarse los pasos obligatorios.
6. En el sidebar se muestra el acceso como elemento principal y el punto de control como elemento secundario.
7. El sidebar es colapsable y esta limitado a `100vh` con scroll propio.
8. El menu de usuario muestra imagen real del operador de EOLO, nombre, ajustes, sincronizar y cerrar sesion.

### Movimientos operador

La tabla de movimientos ahora consulta por defecto los AccesoMovimiento con `Created Date` de los ultimos 30 dias hasta hoy, en el acceso y punto de control activos.

UI aplicada:

- Se oculto el titulo `Camaras`.
- Se oculto el selector de periodo `Hoy / Esta Semana / Este Mes / Otro Periodo`.
- La fecha visible indica el contexto `Ultimos 30 dias`.
- `Ult. Sinc.` muestra fecha y hora de la ultima descarga real de movimientos.
- Busqueda y filtro tienen estado activo con fondo/borde azul y boton `X` para limpiar.
- Tabla paginada en cliente cada 10 elementos.
- Botones `Anterior` y `Siguiente` con indicador `Mostrando X-Y de Z`.
- Orden por fecha de modificacion descendente: el ultimo movimiento modificado va primero.

El Bridge tambien ordena defensivamente por `modified_at`, `Modified Date`, `created_at` o fecha de entrada si algun campo no llega desde Bubble.

### Backend workflows Bubble usados o creados

Workflows aplicados en Bubble branch `acc-upd` durante la sesion:

```text
apk_login
bridge_operator_accesses
bridge_operator_control_points
bridge_operator_movements_today
bridge_operator_residents
bridge_operator_create_movement
bridge_operator_egress_movement
bridge_operator_attach_identification_photo
```

`bridge_operator_movements_today` fue extendido sin cambiar endpoint:

```text
GET https://eolo.app/version-73hi5/api/1.1/wf/bridge_operator_movements_today
```

Parametros:

- `access_id` requerido.
- `control_point_id` opcional.
- `date_from` opcional.
- `date_to` opcional.
- `limit` opcional.
- `offset` opcional.
- `sort` opcional.

Comportamiento:

- Si no se envia `date_from`, usa Current Date/Time menos 30 dias.
- Si no se envia `date_to`, usa Current Date/Time.
- Filtra por `Created Date`.
- Ordena por `Modified Date` descendente cuando `sort` se omite o vale `modified_desc`.
- Si `limit` se omite, mantiene comportamiento sin paginar para compatibilidad.
- Si `limit` viene presente, aplica paginacion server-side con `offset` default `0`.
- Respuesta mantiene `movements` y `count`, y agrega `total`, `limit`, `offset`, `sort`.

`bridge_operator_egress_movement` registra salida de un AccesoMovimiento:

```text
POST https://eolo.app/version-73hi5/api/1.1/wf/bridge_operator_egress_movement
```

Parametros:

- `movement_id` AccesoMovimiento requerido.
- `access_id` Accesos requerido.
- `control_point_id` Acceso Punto Control requerido.
- `operator_name` opcional.
- `camera` opcional.

Campos Bubble esperados al egresar:

- `estatus_acceso_os = afuera`
- `horasalida_date = Current Date/Time`
- `policiaegreso_user = Current User`

### Reglas de operacion

El flujo de ingreso/egreso se alineo con la app Bubble web:

- Solo se puede egresar un movimiento con estatus `Ingresado`.
- Un movimiento `Egresado` no debe poder editarse como uno abierto.
- Si el punto de control es `Notificar` o `Solo Registrar`, el movimiento pasa a `Ingresado` al registrarse.
- Si el punto de control requiere `Autorizar`, el movimiento queda `Pendiente` y el flujo Bubble debe ejecutar la solicitud de aprobacion correspondiente.
- El modal muestra chip de estatus con el mismo estilo de la tabla.

### Creacion y edicion de movimientos

El modal de movimiento incluye:

- Seleccion Vehiculo / Peaton.
- Datos principales compactos.
- Detalles de vehiculo colapsados por defecto.
- Busqueda viva de residentes por nombre, telefono o area.
- Overlay flotante de residentes con altura aproximada de 160 px y scroll.
- AccesoResidentes con `EsArea = yes` en fila de chips para seleccion rapida.
- Validacion para seleccionar un residente valido antes de registrar.
- Toasts de cargando, exito, informacion y error.
- Overlay bloqueante durante guardado/egreso para evitar acciones dobles.

Se ocultaron del panel derecho del modal los bloques `Autorizacion` e `Inspeccion`.

### Camara e identificacion

Se agrego soporte local para tomar fotografia de identificacion desde una camara disponible en el equipo host:

- Vista de ajustes para elegir camara local.
- Modal de camara con guia visual para centrar identificacion.
- Boton de camara junto al input `Nombre Completo Visitante`.
- Captura, cambio y eliminacion de foto mientras el movimiento aun no existe.
- Una vez creado el movimiento, la foto de identificacion no se puede eliminar ni cambiar.
- Subida a Bubble mediante workflow `bridge_operator_attach_identification_photo`.

### OpenAI Vision para identificacion

Se agrego configuracion para extraer automaticamente el nombre del visitante desde la foto de identificacion:

- Variables `OPENAI_VISION_ENABLED`, `OPENAI_VISION_API_KEY`, `OPENAI_VISION_MODEL`, `OPENAI_VISION_TIMEOUT_SECONDS`.
- Ajustes en `/operator > Ajustes > Lectura de identificacion`.
- Endpoint Bridge `GET/PUT /api/operator/vision-config`.
- Endpoint Bridge `POST /api/operator/identification/extract-name`.
- Si el feature esta activo y OpenAI responde, el nombre se llena automaticamente en `Nombre Completo Visitante`.

### Estado EOLO Cloud en operador

Se agrego indicador verde/rojo junto a `Ult. Sinc.`:

- Endpoint Bridge `GET /api/operator/cloud-status`.
- Workflow Bubble `bridge_operator_ping`.
- Refresco automatico cada 60 segundos.

### Movimientos offline por sincronizar

El operador puede crear movimientos aunque EOLO Cloud este inaccesible:

- Los registros quedan completos localmente, incluyendo foto de identificacion si existe.
- Se guardan en `data/operator-pending-movements.json`.
- Fotos pendientes en `data/operator-pending-assets/`.
- Endpoint `GET /api/operator/pending-movements`.
- Endpoint `GET /api/operator/pending-movements/:id/photo`.
- Endpoint `POST /api/operator/pending-movements/sync`.
- Si la nube falla, se espera 1 minuto antes de reintentar.
- La UI muestra `Movimientos por sincronizar`; al subir un movimiento desaparece de esa lista.

### Visualizador RTSP en operador

Se agrego vista de camaras RTSP justo arriba del inventario/movimientos:

- Endpoint `GET /api/operator/stream-cameras`.
- Endpoint `POST /api/operator/stream-cameras/start`.
- Endpoint `POST /api/operator/stream-cameras/stop`.
- Player compacto servido por Bridge en `/operator/stream-player/:camera`.
- Cada camara usa iframe con MSE/WebSocket hacia `ANPR_STREAM_PUBLIC_URL`.
- El puerto `8083` del visualizador se publica en Docker.
- Si Bubble no trae los mismos nombres de camara en el punto de control, la UI cae a mostrar las camaras RTSP locales configuradas.

Controles actuales del visualizador:

- Header con titulo, resumen y chevron down/right para ocultar/mostrar todo el visualizador.
- Dentro de cada tarjeta, una barra compacta sobre el log ANPR con:
  - toggle estilo Ionic `Visualizador`;
  - toggle estilo Ionic `Logs`;
  - slider discreto de alto del player (`180px` a `560px`).
- Preferencias persistidas en `localStorage`:
  - `eolo.operator.streamFrameHeight`;
  - `eolo.operator.showAnprLogs`;
  - `eolo.operator.streamCameraCollapsed`.
- Al ocultar el visualizador se ocultan video, controles y logs.

### Overlay de placa y diagnostico ANPR

El procesador ANPR publica lectura y estado por camara:

- `GET /api/operator/anpr-detections`.
- `GET /api/operator/anpr-status`.
- `AnprEolo/app.py` escribe `anpr-detections.json` y `anpr-status.json`.
- `/operator` consulta cada segundo sin activar el loader global.
- Si hay lectura valida fresca, se muestra un overlay tipo placa en la parte inferior central del frame.
- La lectura expira visualmente despues de 30 segundos para evitar datos viejos.
- El log compacto muestra captura/proceso/frames/predicciones/candidatos/OCR/lecturas/rechazos/ultimo OCR rechazado.

Estado actual del demo:

- Stream RTSP demo visible correctamente.
- ANPR captura frames y ejecuta OCR.
- El OCR lee `34A23126`, pero se rechaza por regex actual de minimo 2 letras.
- Pendiente decidir si se flexibiliza el validador de placas o si se usan perfiles por formato/pais.

### UI visual

Se integraron iconos SVG inline de un mismo estilo para:

- Calendario.
- Busqueda.
- Filtros.
- Vehiculo.
- Peaton/persona.
- Acceso tipo puerta/log-in.
- Punto de control tipo pin geografico.
- Camara.
- Limpiar busqueda/filtro.

La UI del operador sigue el lineamiento visual de las capturas Bubble: superficies blancas, azul EOLO para acciones principales, cards compactas, tabla densa y modales funcionales.

## 15. Uso local

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
http://localhost:8080/operator
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
node --check public/operator.js
```

Para detener:

```bash
docker compose down
```

Para reiniciar:

```bash
docker compose restart eolo-access-bridge anpr-api
```

## 16. Commits recientes importantes

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

## 17. Estado git y nota importante sobre AnprEolo

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
- endpoints `GET /api/anpr/detections` y `GET /api/anpr/status`;
- publicacion local de `anpr-detections.json` y `anpr-status.json`;
- preservacion de token Bubble si no se envia nuevo token desde la UI;
- retiro del flujo operativo de estacionamientos/cobros.

Antes de entregar formalmente conviene decidir si:

1. Se commitea `AnprEolo` como repo independiente.
2. Se absorbe `AnprEolo` dentro del repo raiz.
3. Se declara submodulo/subtree con version fija.

## 18. Pendientes y riesgos

- Reinicio necesario: si se agregan camaras RTSP nuevas o se cambian parametros de arranque, reiniciar `Procesador ANPR` para asegurar que lea la configuracion.
- Visualizador RTSP: si se cambia el listado de camaras, usar el toggle `Visualizador` para reiniciar el preview o reiniciar el servicio `rtsp-preview`.
- Validador OCR: el regex actual rechaza placas con una sola letra aunque sean validas para el stream demo (`34A23126`). Definir formato aceptado antes de usar en produccion.
- Seguridad: la UI local aun no tiene autenticacion propia. No exponerla fuera de una LAN confiable.
- Secretos: `AnprEolo/config.json` puede contener RTSP y tokens. Evitar commitear secretos reales.
- Branch/live: los cambios Bubble se aplicaron sobre `acc-upd`; antes de produccion revisar/promover workflows y cambiar `EOLO_OPERATOR_VERSION` a `live`.
- Camara local: confirmar permisos reales del navegador/host Mac para listar camaras, tomar foto y subir identificacion.
- QA operador: validar flujo completo en caseta real: login -> acceso -> punto de control -> crear movimiento -> foto ID -> egresar -> sync.
- Paginacion Bubble: verificar con volumen real que `limit`, `offset` y orden por `Modified Date` respondan como se espera.
- Reemplazo de rostro Hikvision: si el dispositivo responde `deviceUserAlreadyExistFace`, puede requerirse flujo especifico de reemplazo/borrado.
- Paginacion real: el directorio de empleados usa paginacion visual; revisar paginacion contra `UserInfo/Search` si crece mucho.
- Pruebas automatizadas: faltan tests para normalizadores EOLO, payloads Hikvision y payloads ANPR.
- Retencion: definir politica para `logs.jsonl`, `events.jsonl`, capturas ANPR y `uploads`.
- Contrato EOLO final: confirmar endpoints definitivos para visitas/accesos y tareas del agente local.
- Archivos operador: `public/operator.html`, `public/operator.css`, `public/operator.js` y assets relacionados son nuevos; decidir estrategia de commit junto con cambios Bubble documentados.
- Docker Hub: preparar push de `eolo-access-bridge` version `0.2.0` una vez que Docker local pueda resolver metadata/build o usando una imagen commiteada desde el contenedor actualizado.

## 19. Siguiente paso recomendado

Antes de seguir agregando funciones:

1. Regularizar `AnprEolo` en git.
2. Validar login operador con usuario de prueba `3334677845` y PIN `2325` contra branch `acc-upd`.
3. Validar flujo operador completo contra Bubble: acceso autorizado -> punto de control -> movimientos ultimos 30 dias -> crear -> egresar -> foto ID -> sync.
4. Definir y ajustar el validador de placas ANPR para aceptar formatos reales esperados, incluyendo el demo si aplica.
5. Validar con una camara RTSP real que `Procesador ANPR` detecta vehiculos/placas.
6. Validar apertura real de una barrera ISAPI desde `Barreras`.
7. Probar flujo completo: placa detectada -> movimiento local -> barrera -> sync a EOLO Cloud.
8. Decidir autenticacion local minima para proteger la UI de setup.
9. Promover workflows Bubble de `acc-upd` a live solo despues de QA y actualizar `EOLO_OPERATOR_VERSION=live`.

## 20. Corte 2026-08-11 - Operador v0.2.0

Version local visible en login: `v0.2.0`.

Cambios funcionales principales implementados en `/operator`:

- Login modernizado con PIN segmentado de 4 digitos, emblema de puerta/acceso corregido y loader de autenticacion.
- Ajustes OpenAI Vision para lectura de identificaciones con timeout/fallback; al leer una identificacion se muestra loader junto al estado.
- Captura local de foto de identificacion y extraccion automatica de nombre completo.
- Consulta de historial por placa contra EOLO Cloud:
  - normaliza placa a mayusculas y solo alfanumericos;
  - rellena nombre del visitante;
  - recupera foto historica de identificacion si existe;
  - recupera detalles de vehiculo desde campos cloud o desde `descripcionvehiculo_text` legado.
- Mensaje de recuperacion por placa movido debajo de `Nombre Completo Visitante`.
- Tarjeta `Vehiculo` con controles `Entrada`/`Salida` en la misma fila del titulo.
- Fotos de vehiculo separadas por pestaña:
  - `vehicle_photo_data_url` para entrada;
  - `vehicle_exit_photo_data_url` para salida.
- Flujo ANPR por tipo de camara:
  - camara `Entrada`: clic en placa abre flujo de nuevo movimiento con placa y foto de entrada;
  - camara `Salida`: clic en placa busca movimiento `Ingresado` por placa y abre el modal listo para egresar, colocando la foto en `Salida`.
- Movimiento registrado queda de solo lectura.
- Sidebar fijo al 100% de la ventana; contenido de movimientos/ajustes scrollea.
- Lista de movimientos por sincronizar y cola local offline para movimientos no subidos a EOLO Cloud.
- Indicador EOLO Cloud verde/rojo con ping ligero periodico.
- Visualizador RTSP integrado sobre movimientos con overlay ANPR de placa leida y controles compactos.

Cambios Bridge / Cloud relevantes:

- Endpoint local `GET /api/operator/plate-history` para consulta cloud por placa.
- El endpoint usa `Cache-Control: no-store`; frontend agrega cache-buster para evitar respuestas anteriores.
- `createOperatorCloudMovement` acepta y adjunta foto historica de identificacion por URL.
- Egreso envia foto de salida como mejor esfuerzo (`exit_photo_url`, `exit_image_url`, `imagen_salida_file`, `vehicle_exit_photo_url`) si el workflow cloud lo soporta.
- Buildprint confirmado para campos Bubble:
  - `placas_text`;
  - `nombre_responsable_text`;
  - `id_frontal_file`;
  - `descripcionvehiculo_text`;
  - `imagen_entrada_file`.

Estado Docker al cierre:

- `eolo-access-bridge` corriendo healthy en `localhost:8080`.
- `eolo-anpr-api` corriendo healthy y preview RTSP reactivado.
- Debido a bloqueo local resolviendo metadata de `node:22-alpine`, el ultimo cambio se aplico al contenedor con:

```bash
docker cp public/. eolo-access-bridge:/app/public/
docker cp src/. eolo-access-bridge:/app/src/
docker restart eolo-access-bridge
```

Antes de publicar a Docker Hub se recomienda generar imagen limpia o commitear el contenedor actualizado si Docker build sigue bloqueado:

```bash
docker commit eolo-access-bridge eolo-access-bridge:0.2.0
docker tag eolo-access-bridge:0.2.0 <dockerhub-namespace>/eolo-access-bridge:0.2.0
docker tag eolo-access-bridge:0.2.0 <dockerhub-namespace>/eolo-access-bridge:latest
docker push <dockerhub-namespace>/eolo-access-bridge:0.2.0
docker push <dockerhub-namespace>/eolo-access-bridge:latest
```

Docker Hub publicado:

```bash
docker pull eoloapp/eolo-access-bridge:0.2.0
docker pull eoloapp/eolo-access-bridge:latest
```

Digest publicado:

```text
sha256:b736f5ba48c5b996af2b045b528b3573cc7c815c98f1c6da826350d4f40abc1f
```

Notas pendientes para distribucion:

- La distribucion simple queda resuelta con la imagen all-in-one documentada en el corte 21.
- Mantener `docker-compose.yml` separado como opcion de desarrollo/debug cuando convenga aislar Bridge y ANPR.

## 21. Corte 2026-08-11 - Imagen all-in-one Bridge + ANPR

Se implemento una variante Docker all-in-one para distribuir el sistema completo en una sola imagen pullable:

- Access Bridge Node/Express en puerto interno `8080`.
- ANPR API Python/Gunicorn en puerto interno `8090`.
- Visualizador RTSP/MSE en puerto interno `8083`.
- `ANPR_API_BASE_URL` apunta por defecto a `http://127.0.0.1:8090` dentro del mismo contenedor.
- Datos persistentes:
  - Bridge: `/app/data` y `/app/uploads`;
  - ANPR: `/app/data/anpr`;
  - config ANPR: `/app/data/anpr/config.json`;
  - base ANPR: `/app/data/anpr/plates.db`;
  - detecciones/estado ANPR: `/app/data/anpr/anpr-detections.json` y `/app/data/anpr/anpr-status.json`.
- Se agrego `AnprEolo/config.default.json` con camaras demo `Entrada`/`Salida` usando el RTSP demo de Plate Recognizer.
- Se excluyeron de build los archivos locales sensibles `AnprEolo/config.json`, `AnprEolo/plates.db` y capturas locales.

Archivos agregados:

- `Dockerfile.all-in-one`
- `docker/all-in-one-entrypoint.sh`
- `AnprEolo/config.default.json`

Imagen publicada en Docker Hub:

```bash
docker pull eoloapp/eolo-access-bridge:0.2.0-all-in-one
docker pull eoloapp/eolo-access-bridge:all-in-one-latest
docker pull eoloapp/eolo-access-bridge:0.2.0-all-in-one-amd64
```

Digest multi-arquitectura publicado para `0.2.0-all-in-one` y `all-in-one-latest`:

```text
sha256:ed21dcd386cc5753ab06eac133cc8a8a1c0e84771d6395b81ab9a6bb52c39abb
```

Manifests incluidos:

- `linux/arm64`: `sha256:53503bdb8775fe24ae39358798f2e04566da2173c132efc3f3f69027bb909409`
- `linux/amd64`: `sha256:a97ac7a6fb8f3aec17e6e0bf3f2ebbe52441286f7f8516dcbda7623518482f07`

Tag dedicado AMD64:

```text
eoloapp/eolo-access-bridge:0.2.0-all-in-one-amd64
```

Comando recomendado para probar en otro equipo:

```bash
docker volume create eolo_access_data
docker volume create eolo_access_uploads

docker run -d \
  --name eolo-access-bridge \
  -p 8080:8080 \
  -p 8083:8083 \
  -e ANPR_STREAM_PUBLIC_URL=http://localhost:8083 \
  -v eolo_access_data:/app/data \
  -v eolo_access_uploads:/app/uploads \
  --restart unless-stopped \
  eoloapp/eolo-access-bridge:0.2.0-all-in-one
```

Validacion local realizada con puertos alternos:

```bash
docker run -d \
  --name eolo-all-in-one-test \
  -p 18080:8080 \
  -p 18083:8083 \
  -e ANPR_STREAM_PUBLIC_URL=http://localhost:18083 \
  eolo-access-bridge:0.2.0-all-in-one
```

Resultado observado:

- contenedor `healthy`;
- `GET http://localhost:18080/api/health` OK;
- login `/operator.html` muestra `v0.2.0`;
- `GET http://127.0.0.1:8090/api/health` dentro del contenedor OK;
- `anpr-processor` corriendo;
- `rtsp-preview` arrancado correctamente por API.

## 22. Corte 2026-08-11 - Operador v0.2.1 rama EOLO Cloud editable

Version local visible en login: `v0.2.1`.

Cambio implementado:

- Nueva tarjeta `EOLO Cloud tecnico` en `/operator > Ajustes`.
- Permite seleccionar rama Bubble:
  - `acc-upd` (`73hi5`);
  - `Produccion` (`live`);
  - `Custom`.
- Permite editar `URL base`, por default `https://eolo.app`.
- Muestra el workflow efectivo que usara `/operator`, por ejemplo:
  - `https://eolo.app/version-73hi5/api/1.1/wf`;
  - `https://eolo.app/api/1.1/wf` para `live`;
  - `https://eolo.app/version-<custom>/api/1.1/wf`.
- El ajuste queda persistido en `/app/data/device-config.json`.

Endpoints agregados:

- `GET /api/operator/cloud-config`
- `PUT /api/operator/cloud-config`

Validacion realizada:

- `node --check` en `src/runtimeConfig.js`, `src/server.js`, `public/operator.js`.
- Imagen temporal `0.2.1-all-in-one` healthy en puertos `19080/19083`.
- Login local de prueba con `EOLO_OPERATOR_AUTH_MODE=pin`.
- `GET /api/operator/cloud-config` regreso rama `acc-upd`.
- `PUT /api/operator/cloud-config` guardo rama custom `qa_branch`.
- Confirmado en `/app/data/device-config.json`.

Docker Hub publicado:

```bash
docker pull eoloapp/eolo-access-bridge:0.2.1-all-in-one
docker pull eoloapp/eolo-access-bridge:all-in-one-latest
docker pull eoloapp/eolo-access-bridge:0.2.1-all-in-one-amd64
```

Digest multi-arquitectura publicado para `0.2.1-all-in-one` y `all-in-one-latest`:

```text
sha256:71cf99fd04012903c1587324f33ba538d865384201cb8b6f56c08f28fc1a70a6
```

Manifests incluidos:

- `linux/arm64`: `sha256:721beb897e61a94fbaf1cd4604ea8030cbda1601cca7d45e6ac0999480d7e259`
- `linux/amd64`: `sha256:0826afaae7fe0007fe75a08a0b65ad992b2408a178a03d9c4c4008c1b3bd0f67`

## 23. Corte 2026-08-12 - Operador v0.2.2 monitoreo DispositivosAcceso

Version local visible en login: `v0.2.2`.

Cambios implementados:

- Login simplificado: se retiro el icono/grupo de puerta y la leyenda `Operador local`; solo queda la version.
- Al cerrar sesion, el telefono y PIN quedan limpios para el siguiente inicio.
- El card de login muestra estado vivo de:
  - `EOLO Cloud`, usando comunicacion con el endpoint alive/ping de Bubble;
  - `Bridge local`;
  - `ANPR`.
- En `/ > Ajustes > EOLO Cloud tecnico` se agrego configuracion del cliente local en Bubble:
  - activar/desactivar monitoreo del cliente;
  - `Identificador fijo` que se usa como `id_text`;
  - workflow heartbeat configurable, default `bridge_operator_device_heartbeat`;
  - data type informativo/configurable, default `dispositivosacceso`;
  - identificador efectivo.
- Cada Sync de operador llama el heartbeat de Bubble para actualizar `DispositivosAcceso.UltimaComunicacion`.
- El heartbeat ya no usa Bubble Data API directo, porque `custom.dispositivosacceso` no estaba expuesto en Data API y devolvia `Type not found dispositivosacceso`.
- Se creo y aplico en Bubble, rama `73hi5` (`acc-upd`), el backend workflow:

```text
bridge_operator_device_heartbeat
```

Contrato del workflow:

- Metodo: `POST`
- Auth: requiere usuario Bubble autenticado.
- Parametros:
  - `device_id` (`text`) requerido;
  - `sn` (`text`) opcional;
  - `access_id` (`custom.accesos`) opcional.
- Comportamiento:
  - busca `custom.dispositivosacceso` por `id_text = device_id`;
  - si existe, actualiza `ultimacomunicacion_date`, `sn_text` y `acceso_custom_accesos`;
  - si no existe, crea el registro;
  - retorna `ok`, `device_id` y el `device`.

Variables nuevas/relevantes:

```env
EOLO_OPERATOR_DEVICE_HEARTBEAT_ENABLED=true
EOLO_OPERATOR_DEVICE_HEARTBEAT_ENDPOINT=bridge_operator_device_heartbeat
EOLO_OPERATOR_DEVICE_HEARTBEAT_METHOD=POST
EOLO_OPERATOR_DEVICE_DATA_TYPE=dispositivosacceso
EOLO_OPERATOR_DEVICE_ID=
```

Notas operativas:

- Para evitar duplicados en Bubble, definir un `Identificador fijo` por equipo/caseta, por ejemplo `caseta-periferico-01`.
- Si se deja vacio, el bridge usa `LOCAL_DEVICE_ID` o genera un ID persistente en `/app/data/bridge-device-id`.
- En Docker es importante montar un volumen en `/app/data` para conservar configuracion, ID local, movimientos pendientes y ajustes.

Validacion realizada:

- `node --check` en `src/server.js` y `public/operator.js`.
- `buildprint check` limpio sobre el workflow Bubble.
- `buildprint apply parco 73hi5` aplicado correctamente.
- Buildprint confirmo registros en `custom.dispositivosacceso` con `ultimacomunicacion_date` reciente.
- Imagen all-in-one local `eolo-access-bridge:route-test` healthy en `localhost:8080`.

Docker Hub publicado:

```bash
docker pull eoloapp/eolo-access-bridge:0.2.2-all-in-one
docker pull eoloapp/eolo-access-bridge:all-in-one-latest
docker pull eoloapp/eolo-access-bridge:0.2.2-all-in-one-amd64
```

Digest publicado para `0.2.2-all-in-one`, `0.2.2-all-in-one-amd64` y `all-in-one-latest`:

```text
sha256:33d9fd5db5c5dc0861296f895efadd5be05b6083a98d3aea1852e6c494475cf5
```

Manifest `linux/amd64`:

```text
sha256:699037aa64b9a4f1b49a75d7807844f0b43784e3a8a9c1fce149c86029257fab
```

## 24. Corte 2026-08-14 - Operador v0.2.3 WebRTC y ajustes de flujo

Version local visible en login: `v0.2.3`.

Cambios implementados:

- La ruta base `/` queda como panel de operador y la vista tecnica/API queda en `/settings`.
- El visualizador de camaras migro a WebRTC ligero con `go2rtc`, manteniendo `8083` como fallback/preview y agregando `1984`/`8555` para WebRTC.
- En `/settings` se homologo el UI visual con la vista de operador y se mejoraron los tabs de `Procesador ANPR`.
- Los controles globales del visualizador de camaras quedan compactos, discretos y fuera del grid de camaras.
- En la linea de `Ult. Sinc.` se agrego accion manual de refresh equivalente a `Sincronizar`.
- La tabla de movimientos muestra la fecha actual en el plate superior y mueve `Ultimos 30 dias` al resumen inferior.
- El login limpia telefono/PIN al cerrar sesion y muestra estados `EOLO Cloud`, `Bridge local` y `ANPR`.
- El grupo de `Detalles de vehiculo` vuelve a funcionar como header clickeable, con icono dropdown, oculto por defecto.
- En movimientos tipo `Peaton` se ocultan placas, numero economico y detalles de vehiculo; en `Vehiculo` se muestran normalmente.

Variables nuevas/relevantes para Docker all-in-one:

```env
ANPR_STREAM_PUBLIC_URL=http://localhost:8083
ANPR_WEBRTC_PUBLIC_URL=http://localhost:1984
ANPR_WEBRTC_ICE_HOST=localhost
ANPR_WEBRTC_AUTOSTART=true
```

Puertos recomendados:

```text
8080  Bridge + operador/settings
8083  preview/player MSE
8090  API ANPR local
1984  go2rtc WebRTC/API
8555  WebRTC TCP/UDP
```

Validacion realizada:

```bash
node --check public/operator.js
docker buildx build --platform linux/amd64 -f Dockerfile.all-in-one \
  --build-arg ANPR_BASE_IMAGE=eoloapp/eolo-access-bridge:0.2.2-all-in-one-amd64 \
  -t eolo-access-bridge:webrtc-test --load .
docker ps --filter name=eolo-access-bridge
```

Docker Hub publicado:

```bash
docker pull eoloapp/eolo-access-bridge:0.2.3-all-in-one
docker pull eoloapp/eolo-access-bridge:all-in-one-latest
docker pull eoloapp/eolo-access-bridge:0.2.3-all-in-one-amd64
```

Digest publicado para `0.2.3-all-in-one`, `0.2.3-all-in-one-amd64` y `all-in-one-latest`:

```text
sha256:2c7745a1f8d52fa3c37e2328b1939c7ebf029c7c9684a8f628edcd8a24893c05
```

Manifest `linux/amd64`:

```text
sha256:d9f82753bf1bdb9167985db78495983714739cddf6d725a8ce0eb702bfd57995
```

Arranque recomendado en Windows limpio con Docker:

```cmd
docker pull eoloapp/eolo-access-bridge:0.2.3-all-in-one-amd64
docker rm -f eolo-access-bridge
docker run -d --name eolo-access-bridge ^
  -p 8080:8080 -p 8083:8083 -p 8090:8090 -p 1984:1984 -p 8555:8555 -p 8555:8555/udp ^
  -e ANPR_STREAM_PUBLIC_URL=http://localhost:8083 ^
  -e ANPR_WEBRTC_PUBLIC_URL=http://localhost:1984 ^
  -e ANPR_WEBRTC_ICE_HOST=localhost ^
  -e ANPR_WEBRTC_AUTOSTART=true ^
  -v eolo_access_data:/app/data ^
  -v eolo_access_uploads:/app/uploads ^
  --restart unless-stopped ^
  eoloapp/eolo-access-bridge:0.2.3-all-in-one-amd64
```

## Estado 2026-08-18 11:35 CST - Operador: inventario, acompañantes y conductores

Cambios implementados localmente para la vista de operador:

- El conteo de inventario de vehiculos/personas dentro del acceso ya no depende solo de la pagina actual de movimientos. Cuando EOLO Cloud esta disponible se consulta `AccesoMovimiento` via Data API y se resume sobre movimientos con estatus ingresado/adentro para alinear el conteo con la vista web de Bubble `acceso > Movimientos`. Si la consulta de inventario cloud falla, se conserva fallback local sobre los movimientos cargados.
- Se agrego soporte de `Acompañantes` en el modal de acceso movimiento:
  - captura de nombre;
  - captura/cambio de foto desde camara de identificacion;
  - eliminacion local antes de guardar;
  - persistencia en cola offline junto con sus fotos;
  - al sincronizar/subir a nube, se crean movimientos hijo ligados al `AccesoMovimiento` padre mediante `movimiento_padre_custom_accesomovimiento` y se actualiza `lista_acompa_antes_list_custom_accesomovimiento`.
- Se amplio la busqueda por placa para recuperar perfil de vehiculo y conductores:
  - consulta `Vehicle` por `placas_text`;
  - carga `Conductores` asociados desde `conductor_list_custom_conductor`;
  - muestra badge/toast de visitante registrado;
  - permite seleccionar otro conductor existente o registrar uno nuevo;
  - al crear movimiento, liga `vehiculo_custom_vehicle` y `conductor_custom_conductor`;
  - si se registra nuevo conductor, queda agregado a la lista de conductores del vehiculo para futuras visitas.
- En Ajustes tecnicos de EOLO Cloud:
  - la rama default pasa a produccion (`live`);
  - el selector incluye `version-test` como opcion de pruebas; internamente se guarda como `test` para construir `/version-test`;
  - el input custom de rama solo se muestra cuando el selector esta en `Custom`;
  - el identificador fijo usa un valor persistente generado a partir de datos locales del equipo si el usuario no lo captura;
  - `bridge_operator_device_heartbeat` y `dispositivosacceso` quedan fijos/no editables, pero visibles para soporte.

Contratos Bubble usados/validados con export Buildprint local:

- `custom.accesomovimiento`
  - `vehiculo_custom_vehicle`
  - `conductor_custom_conductor`
  - `lista_acompa_antes_list_custom_accesomovimiento`
  - `movimiento_padre_custom_accesomovimiento`
  - `id_frontal_file`
  - `imagen_entrada_file`
  - `imagen_salida_file`
- `custom.vehicle`
  - `placas_text`
  - `conductor_list_custom_conductor`
  - `numeconomico_text`, `color_text`, `make_text`, `model_text`, `yearmodel_number`
- `custom.conductor`
  - `nombre_text`
  - `telefono_text`
  - `id_frontal_file`

Nota Buildprint:

- Se intento clonar la rama de pruebas `bridge-dev`, pero `buildprint project clone parco --branch bridge-dev` quedo sin finalizar y se detuvo manualmente.
- No se modificaron workflows Bubble en esta pasada.
- No se tocaron workflows con prefijo `apk`.
- Los cambios usan workflows existentes `bridge_operator_create_movement`, `bridge_operator_egress_movement`, `bridge_operator_attach_identification_photo` y Data API para completar vehiculo/conductor/acompañantes.

Validacion local realizada:

```bash
node --check src/server.js
node --check public/operator.js
docker exec eolo-access-bridge node --check /app/src/server.js
docker exec eolo-access-bridge node --check /app/public/operator.js
curl -fsS http://localhost:8080/api/health
```

Pendiente de QA funcional:

- Probar contra sesion cloud valida que Data API permita crear/actualizar `Vehicle`, `Conductor` y movimientos hijo.
- Validar que el conteo de inventario coincide con Bubble `acceso > Movimientos` para el mismo acceso/punto y estatus.
- Validar flujo offline con acompañantes: crear offline, reconectar, sincronizar y confirmar que desaparece de pendientes.

## Estado 2026-08-20 - Piloto instalable Electron

Se inicio la ruta practica para instalar el primer piloto sin depender de abrir el navegador manualmente:

- Se agrego Electron como envoltura de escritorio para EOLO Access Bridge.
- El proceso principal vive en `desktop/main.cjs`.
- La app Electron arranca el servidor Express local embebido y abre directamente la vista de operador en una ventana nativa.
- Para evitar choques con Docker o servicios locales existentes, Electron busca un puerto libre iniciando en `18080`.
- Los datos locales y fotos del piloto se guardan por usuario en la carpeta `userData` de Electron:
  - `data`
  - `uploads`
- Se agregaron opciones de menu:
  - Operador
  - Ajustes
  - Abrir carpeta de datos
  - Abrir carpeta de fotos
  - Recargar
  - Herramientas de desarrollador
- Se agregaron scripts:
  - `npm run desktop`
  - `npm run desktop:dir`
  - `npm run desktop:mac`
  - `npm run desktop:win`
- Se configuro `electron-builder` para generar:
  - DMG macOS sin firma para piloto interno;
  - instalador NSIS Windows x64 sin firma;
  - artefactos en `release/`.
- Se actualizo la version visible del login a `v0.2.3`.

### Empaquetado all-in-one con ANPR

Se completo una primera variante all-in-one para macOS ARM64:

- `AnprEolo/web_config.py` se empaqueta con PyInstaller como sidecar `anpr-eolo`.
- `web_config.py` ahora soporta modo `--anpr-worker` para relanzar el procesador ANPR desde el mismo binario congelado.
- `app.py` resuelve modelos YOLO desde el bundle PyInstaller:
  - `model.pt`
  - `best.pt`
- El config y la base ANPR se guardan en la carpeta de usuario de Electron:
  - `~/Library/Application Support/EOLO Access Bridge/anpr/config.json`
  - `~/Library/Application Support/EOLO Access Bridge/anpr/plates.db`
  - `~/Library/Application Support/EOLO Access Bridge/anpr/anpr-detections.json`
  - `~/Library/Application Support/EOLO Access Bridge/anpr/anpr-status.json`
- Electron arranca el sidecar ANPR antes del Bridge.
- Electron detecta puerto libre para ANPR empezando por `8090` y configura `ANPR_API_BASE_URL` para el Bridge.
- Se incluyo `go2rtc` como sidecar nativo para WebRTC.
- Electron apunta `GO2RTC_BINARY` al binario empaquetado.
- Al cerrar la app, Electron detiene:
  - WebRTC/go2rtc desde el endpoint local del Bridge;
  - sidecar ANPR.

Archivos nuevos relevantes:

- `desktop/main.cjs`
- `AnprEolo/anpr-sidecar.spec`
- `scripts/prepare-desktop-sidecars.mjs`
- `scripts/build-anpr-sidecar.sh`
- `scripts/build-anpr-sidecar.ps1`

Comandos de desarrollo/QA:

```bash
npm install
npm run desktop
npm run sidecars:prepare
npm run anpr:build
npm run desktop:dir
npm run desktop:mac
npm run desktop:win
npm run desktop:mac:full
```

Build macOS all-in-one generado en esta pasada:

```text
release/EOLO Access Bridge-0.2.3-arm64.dmg
release/mac-arm64/EOLO Access Bridge.app
dist/anpr-eolo/anpr-eolo
vendor/sidecars/go2rtc/darwin-arm64/go2rtc
```

Tamanos observados:

```text
release/EOLO Access Bridge-0.2.3-arm64.dmg   435 MB
dist/anpr-eolo                               929 MB
dist/anpr-eolo/anpr-eolo                      49 MB
vendor/sidecars/go2rtc/darwin-arm64/go2rtc    18 MB
```

Checksum SHA-256:

```text
936998f3aba141c57bbb1ca6981042893cc669e51b55f5129d785364c1e660b9  release/EOLO Access Bridge-0.2.3-arm64.dmg
```

Validacion ejecutada:

```bash
node --check desktop/main.cjs
node --check scripts/prepare-desktop-sidecars.mjs
node --check src/server.js
node --check public/operator.js
python3 -m py_compile AnprEolo/app.py AnprEolo/web_config.py
npm ls electron electron-builder --depth=0
npm run sidecars:prepare
npm run anpr:build
npm run desktop:dir
npm run desktop:mac
open "release/mac-arm64/EOLO Access Bridge.app"
curl -fsS http://127.0.0.1:18080/api/health
curl -fsS http://127.0.0.1:8090/api/health
curl -fsS http://127.0.0.1:18080/api/services
curl -fsS -X POST http://127.0.0.1:18080/api/services/webrtc-preview/start
curl -fsS http://127.0.0.1:1984/api/streams
```

Resultado QA macOS:

- Bridge embebido OK.
- Sidecar ANPR PyInstaller OK.
- `anpr-processor` arranca como proceso hijo del sidecar.
- `go2rtc` empaquetado arranca desde el Bridge.
- WebRTC expone streams demo desde el config default.
- Al cerrar la app no quedan procesos `anpr-eolo`, `go2rtc` ni Electron activos.

Notas para Windows:

- No se puede producir un sidecar ANPR Windows real desde macOS; PyInstaller debe ejecutarse en Windows para incluir binarios nativos de Python/OpenCV/PyTorch/onnxruntime.
- Se agrego guardrail `scripts/electron-before-pack.cjs`: `electron-builder --win` queda bloqueado si no existe `dist/anpr-eolo/anpr-eolo.exe`, evitando generar un instalador Windows con sidecar macOS por error.
- Se descargo `go2rtc.exe` Windows en `vendor/sidecars/go2rtc/win32-x64/go2rtc.exe`.
- En Windows, usar:

```powershell
npm install
npm run sidecars:prepare
npm run anpr:build:win
npm run desktop:win
```

- O el flujo completo:

```powershell
npm run desktop:win:full
```

Intento local desde macOS:

```bash
npm run desktop:win
```

Resultado esperado/validado: build bloqueado por falta de `dist/anpr-eolo/anpr-eolo.exe`.

Notas de instalacion sin firma:

- macOS: para piloto interno puede requerir clic derecho > Abrir la primera vez, o permitirlo desde Privacidad y seguridad.
- Windows: puede mostrar SmartScreen; para piloto interno se usa Mas informacion > Ejecutar de todos modos.
- Para distribucion real conviene firmar:
  - Apple Developer ID + notarizacion para macOS;
  - certificado Authenticode para Windows.

## Actualizacion 2026-08-21 - repositorio GitHub y branding

Se preparo el proyecto para quedar versionado como `EOLO Access Bridge`:

- Se actualizo el nombre tecnico del paquete de `eolo-hikvision-local` a `eolo-access-bridge`.
- Se cambio el titulo visible del panel base a `EOLO Access Bridge`.
- Se actualizo el log de arranque del servidor para referirse al servicio como `EOLO Access Bridge`.
- Se conserva la palabra Hikvision solo donde describe integraciones tecnicas ISAPI/Face Recognition.
- El repo local quedo publicado en GitHub desde la rama `main`.

Repositorio:

- URL: `https://github.com/joqr231210/EOLO-Access-Bridge`
- Visibilidad inicial: privado.

Validacion ejecutada despues del cambio:

```bash
node --check src/server.js
node --check desktop/main.cjs
git diff --check
```

## Actualizacion 2026-08-21 - Docker Hub v0.2.4

Version local visible en login: `v0.2.4`.

Contenido del corte:

- Cliente/panel local EOLO Access Bridge en `/`.
- Ajustes tecnicos en `/settings`.
- ANPR incluido en la imagen all-in-one.
- Visualizador WebRTC/go2rtc incluido en la imagen all-in-one.
- Branding actualizado de `EOLO Hikvision Local` a `EOLO Access Bridge`.
- Repo GitHub privado publicado en `https://github.com/joqr231210/EOLO-Access-Bridge`.

Build/push planeado:

```bash
docker buildx build --platform linux/amd64 -f Dockerfile.all-in-one \
  --build-arg ANPR_BASE_IMAGE=eoloapp/eolo-access-bridge:0.2.3-all-in-one-amd64 \
  -t eoloapp/eolo-access-bridge:0.2.4-all-in-one \
  -t eoloapp/eolo-access-bridge:0.2.4-all-in-one-amd64 \
  -t eoloapp/eolo-access-bridge:all-in-one-latest \
  --push .
```

Docker Hub publicado:

```bash
docker pull eoloapp/eolo-access-bridge:0.2.4-all-in-one
docker pull eoloapp/eolo-access-bridge:0.2.4-all-in-one-amd64
docker pull eoloapp/eolo-access-bridge:all-in-one-latest
```

Digest publicado:

```text
sha256:01f501c2484c207121284efe9f87eb666d2135206a88fbf8f1569dcd404e5b41
```

Manifest `linux/amd64`:

```text
sha256:54cae183326b3c1834cbebf638a85cfa1e64428b227d5226f08fe3fb0f4441e3
```

### Script Windows Docker

Se agrego `scripts/run-eolo-access-bridge-docker.ps1` para equipos Windows con Docker Desktop instalado:

- hace pull de `eoloapp/eolo-access-bridge:0.2.4-all-in-one-amd64`;
- reemplaza el contenedor `eolo-access-bridge` si ya existe;
- crea/reutiliza volumes `eolo_access_data` y `eolo_access_uploads`;
- publica puertos `8080`, `8083`, `8090`, `1984` y `8555/tcp+udp`;
- configura variables ANPR/WebRTC para uso local.
- conserva la ventana abierta y muestra instrucciones si Docker Hub responde `authentication required`.

Uso rapido desde PowerShell:

```powershell
cd $env:USERPROFILE\Downloads
powershell -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri https://gist.githubusercontent.com/joqr231210/30692d997dcf49a183da9c37e3ad2016/raw/run-eolo-access-bridge-docker.ps1 -OutFile run-eolo-access-bridge-docker.ps1"
powershell -ExecutionPolicy Bypass -File .\run-eolo-access-bridge-docker.ps1
```

Gist secret usado para descarga sin depender del repo privado:

```text
https://gist.github.com/joqr231210/30692d997dcf49a183da9c37e3ad2016
```

## Actualizacion 2026-08-21 - ID2 local por dispositivo

Se reviso Bubble `bridge-dev` (`version-13i8l`) con Buildprint:

- `AccesoMovimiento` guarda el folio en `id2_text`.
- El acceso `Acceso Principal Prueba` tiene `Accesos.id2_text = AC34`.
- Los movimientos historicos muestran folios tipo `AC34A951`, `AC34A952`, `AC34A973`.

Implementacion local:

- El cliente envia `access_id2` tomado del acceso activo.
- El servidor genera `id2_text` antes de crear el movimiento.
- Formato local compacto:

```text
<AccessID2><MachineCode><LocalCounter>
AC34K700001
```

- `MachineCode` se deriva del identificador persistente local del bridge.
- `LocalCounter` se guarda en `/app/data/operator-id2-counters.json`, por acceso y maquina.
- Si EOLO Cloud esta offline, el mismo `id2_text` queda en el movimiento pendiente y se sincroniza despues.
- Al crear en Cloud, el payload envia `id2_text` al workflow `bridge_operator_create_movement`.
- La tabla de movimientos prioriza `id2_text`/`id2` como folio visible antes del Unique ID Bubble.

### Correccion ID2 Bubble 2026-08-21

Se detecto que el cliente local si generaba y enviaba `id2_text`, pero el workflow Bubble `bridge_operator_create_movement` no tenia declarado ese parametro ni lo asignaba al nuevo `AccesoMovimiento`.

Correccion aplicada en Bubble `bridge-dev`:

- Se agrego el parametro opcional `id2_text` al endpoint `bridge_operator_create_movement`.
- Se asigno `id2_text` en la accion `Create pending movement` al crear `custom.accesomovimiento`.
- Se elimino del servidor local el intento posterior de PATCH Data API para ID2, ya que el campo debe persistirse atomicamente desde el workflow de creacion.

Validacion ejecutada:

```bash
node --check src/server.js
node --check public/operator.js
git diff --check
```

Validacion posterior al fix en Bubble:

- Movimiento `1787318401699x481307497632044600` creado en `bridge-dev` ya aparece con `id2_text = AC34CI00005`.

## Actualizacion 2026-08-21 - Docker Hub v0.2.5

Version local visible en login: `v0.2.5`.

Contenido del corte:

- Ajustes visuales finales del bloque de camaras en Operador.
- Se conserva el reproductor nativo de go2rtc para WebRTC, evitando el player custom que podia dejar `Visualizador Desconectado`.
- Overlay de nombre y tipo de camara dentro del frame de video.
- Controles globales de camaras mas discretos: icono de ajustes, hover solo por color y layout compacto sin halos grandes.
- Espaciado alineado entre indicadores, buscador y filtros en el layout dividido de una sola camara.

Tags Docker Hub a publicar:

```bash
eoloapp/eolo-access-bridge:0.2.5-all-in-one
eoloapp/eolo-access-bridge:0.2.5-all-in-one-amd64
eoloapp/eolo-access-bridge:all-in-one-latest
```

Script Windows actualizado para descargar:

```text
eoloapp/eolo-access-bridge:0.2.5-all-in-one-amd64
```

### Script Windows seguro

Se robustecio `scripts/run-eolo-access-bridge-docker.ps1` y el gist descargable:

- por default hace pull de `eoloapp/eolo-access-bridge:all-in-one-latest` con `--platform linux/amd64`;
- valida Docker Desktop, puertos locales, volumenes y health del contenedor;
- reemplaza el contenedor existente de forma controlada;
- muestra ultimos logs si el contenedor no queda `healthy`;
- mantiene la ventana abierta siempre, con diagnostico si ocurre un error;
- la URL raw del gist quedo sin revision fija para descargar siempre el script vigente.

## Actualizacion 2026-08-21 - Electron Windows v0.2.6

Version local visible en login: `v0.2.6`.

Correcciones para instalador Windows:

- El cliente Electron ahora deja visible el menu de aplicacion, con accesos `Operador` y `Ajustes` (`Ctrl+1` / `Ctrl+2`).
- El panel de Operador incluye un boton `Panel tecnico` en el sidebar y en el menu de perfil para navegar internamente a `/settings`.
- El panel tecnico `/settings` incluye boton `Operador` para regresar a `/`.
- El sidecar ANPR se lanza con `windowsHide: true`.
- go2rtc/WebRTC se lanza oculto, con stdout/stderr hacia `go2rtc.log` en la carpeta de datos local.
- Se agrego watchdog ligero para reiniciar go2rtc si el proceso cae o si la API deja de responder mientras el visualizador debe permanecer activo.

Build Windows recomendado:

```powershell
npm install
npm run desktop:win:full
```

Salida esperada:

```text
release\EOLO Access Bridge Setup 0.2.6.exe
```

## Actualizacion 2026-08-21 - Electron Windows v0.2.7

Version local visible en login: `v0.2.7`.

Correcciones:

- Los selectores laterales de `Acceso activo` y `Punto de control` ya no muestran texto de cambio cuando ya existe seleccion; solo conservan los datos actuales.
- El proceso ANPR empaquetado se detiene con `taskkill /T /F` en Windows al cerrar Electron para evitar que quede consumiendo recursos.
- Se agregaron acciones de menu `Detener ANPR` y `Reiniciar ANPR`.
- Se integro el logo EOLO en favicon, login, panel tecnico e iconos del instalador Electron (`build/icon.ico` y `build/icon.icns`).

Salida esperada:

```text
release\EOLO Access Bridge Setup 0.2.7.exe
```
