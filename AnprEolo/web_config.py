from flask import Flask, request, render_template, redirect, url_for, Response, stream_with_context, jsonify, send_file
import json, os, subprocess, signal, sys, threading, queue, time, requests, sqlite3, atexit
from requests.auth import HTTPDigestAuth
from bubble_config import (
    BUBBLE_HEADERS,
    URL_GET_PLACAS_RESIDENTES,
    URL_GET_MOV_PREAUTORIZADOS,
    URL_CREATE_ACCESO_MOV_RESIDENTE,
    URL_SALIDA_ACCESO,
    URL_ENTRADA_ACCESO_PREAUTORIZADO,
    URL_GET_EXENTOS_ESTACIONAMIENTO,
    URL_APK_SALIDA_RESERVA,
    URL_GET_PLACAS_INVENTARIO,
    URL_APK_COBRAR
)
from collections import deque

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BUNDLE_DIR = getattr(sys, "_MEIPASS", BASE_DIR)
RUNTIME_DIR = os.environ.get("ANPR_RUNTIME_DIR", BASE_DIR)
CONFIG_FILE = os.environ.get("ANPR_CONFIG_FILE", os.path.join(BASE_DIR, "config.json"))

DEMO_BARRIER = {
    "id_barra": "demo-barrier",
    "numero_barra": "1",
    "ip_puerto": "192.168.1.10:80",
    "usuario": "admin",
    "password": "",
    "camera_name": "",
}
MAIN_APP = os.environ.get("ANPR_MAIN_APP", os.path.join(BUNDLE_DIR, "app.py"))
DB_FILE = os.environ.get("ANPR_DB_FILE", os.path.join(BASE_DIR, "plates.db"))
DETECTIONS_FILE = os.environ.get(
    "ANPR_DETECTIONS_FILE",
    os.path.join(os.path.dirname(DB_FILE), "anpr-detections.json")
)
STATUS_FILE = os.environ.get(
    "ANPR_STATUS_FILE",
    os.path.join(os.path.dirname(DB_FILE), "anpr-status.json")
)
SNAPSHOT_DIR = os.environ.get(
    "ANPR_SNAPSHOT_DIR",
    os.path.join(os.path.dirname(DB_FILE), "anpr-snapshots")
)
STREAM_DIR = os.environ.get("ANPR_STREAM_DIR", os.path.join(BUNDLE_DIR, "stream"))
ANPR_API_PORT = int(os.environ.get("ANPR_API_PORT", os.environ.get("PORT", "8090")))
ANPR_CONTROL_BASE_URL = os.environ.get(
    "ANPR_CONTROL_BASE_URL",
    f"http://127.0.0.1:{ANPR_API_PORT}"
).rstrip("/")
app_process = None   # proceso global
rtsp_process = None  # proceso global
worker_thread = None
worker_stop_event = threading.Event()
worker_started_at = None

# --- LOGS GLOBALES ---
log_buffer = deque(maxlen=20)
clients = []
sync_lock = threading.Lock()

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    # Tabla de vehículos (residentes)
    c.execute('''CREATE TABLE IF NOT EXISTS vehiculos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        placa TEXT UNIQUE,
        nombre TEXT,
        telefono TEXT
    )''')

    # Tabla de movimientos de acceso
    c.execute('''CREATE TABLE IF NOT EXISTS movimientos_acceso (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folio INTEGER,
        placa TEXT,
        telefono TEXT,
        id_acceso TEXT,
        fecha_entrada DATETIME,
        fecha_salida DATETIME,
        camara_entrada TEXT,
        camara_salida TEXT,
        imagen TEXT
    )''')

    # Verificar si las columnas existen en vehiculos (para migraciones sencillas)
    c.execute("PRAGMA table_info(movimientos_acceso)")
    cols_mov = [row[1] for row in c.fetchall()]
    if "imagen" not in cols_mov:
        c.execute("ALTER TABLE movimientos_acceso ADD COLUMN imagen TEXT")
    if "imagen_salida" not in cols_mov:
        c.execute("ALTER TABLE movimientos_acceso ADD COLUMN imagen_salida TEXT")
    if "sync" not in cols_mov:
        c.execute("ALTER TABLE movimientos_acceso ADD COLUMN sync INTEGER DEFAULT 0")
    if "uid_bubble" not in cols_mov:
        c.execute("ALTER TABLE movimientos_acceso ADD COLUMN uid_bubble TEXT")
    if "prefijo" not in cols_mov:
        c.execute("ALTER TABLE movimientos_acceso ADD COLUMN prefijo TEXT")
    operator_columns = {
        "created_at": "DATETIME",
        "updated_at": "DATETIME",
        "visitor_name": "TEXT",
        "notes": "TEXT",
        "movement_type": "TEXT",
        "person_type": "TEXT",
        "vehicle_type": "TEXT",
        "vehicle_category": "TEXT",
        "economic_number": "TEXT",
        "brand": "TEXT",
        "model": "TEXT",
        "vehicle_year": "TEXT",
        "color": "TEXT",
        "short_description": "TEXT",
        "visit_to": "TEXT",
        "area": "TEXT",
        "contact": "TEXT",
        "operator_name": "TEXT",
        "last_operator": "TEXT",
        "inspection_notes": "TEXT"
    }
    for column, column_type in operator_columns.items():
        if column not in cols_mov:
            c.execute(f"ALTER TABLE movimientos_acceso ADD COLUMN {column} {column_type}")

    c.execute("PRAGMA table_info(vehiculos)")
    columns = [row[1] for row in c.fetchall()]
    if "nombre" not in columns:
        c.execute("ALTER TABLE vehiculos ADD COLUMN nombre TEXT")
    if "telefono" not in columns:
        c.execute("ALTER TABLE vehiculos ADD COLUMN telefono TEXT")

    # Tabla de movimientos preautorizados
    c.execute('''CREATE TABLE IF NOT EXISTS movimientos_preautorizados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        placa TEXT NOT NULL,
        uid_movimiento TEXT UNIQUE NOT NULL,
        estatus TEXT DEFAULT 'Preautorizado',
        fecha_ingreso DATETIME,
        imagen_ingreso TEXT,
        camara_ingreso TEXT,
        sync INTEGER DEFAULT 0
    )''')

    # Tabla de placas preautorizadas (una fila por placa)
    c.execute('''CREATE TABLE IF NOT EXISTS placas_preautorizadas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        placa TEXT NOT NULL,
        telefono TEXT,
        movimiento TEXT,
        UNIQUE(placa, movimiento)
    )''')

    # Tabla de exentos de estacionamiento (Placa|ID_Movimiento)
    c.execute('''CREATE TABLE IF NOT EXISTS exentos_estacionamiento (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        placa TEXT NOT NULL,
        id_movimiento TEXT NOT NULL,
        estatus TEXT DEFAULT 'Pendiente',
        UNIQUE(placa, id_movimiento)
    )''')

    # Tabla de movimientos de estacionamiento (salidas por exento)
    c.execute('''CREATE TABLE IF NOT EXISTS movimientos_estacionamiento (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        placa TEXT,
        id_estacionamiento TEXT,
        id_movimiento_reserva TEXT,
        fecha_salida DATETIME,
        camara_salida TEXT,
        imagen_salida TEXT,
        sync INTEGER DEFAULT 0
    )''')

    # Tabla de inventario de estacionamiento
    c.execute('''CREATE TABLE IF NOT EXISTS inventario_estacionamiento (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid_reserva TEXT NOT NULL,
        placa TEXT NOT NULL,
        id_wallet TEXT,
        balance_wallet REAL,
        total_por_pagar REAL,
        por_pagar_reserva REAL,
        por_pagar_servicio REAL,
        UNIQUE(placa, uid_reserva)
    )''')

    # Tabla de cobros de inventario para sync (offline first)
    c.execute('''CREATE TABLE IF NOT EXISTS cobros_inventario (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid_reserva TEXT NOT NULL,
        placa TEXT NOT NULL,
        id_wallet TEXT,
        monto_saldo REAL,
        monto_reserva REAL,
        monto_total REAL,
        sync INTEGER DEFAULT 0
    )''')

    conn.commit()
    conn.close()

init_db()

def monitor_output(proc):
    """Lee stdout del proceso y lo envía a los clientes SSE"""
    try:
        for line in iter(proc.stdout.readline, ''):
            if not line:
                break

            # 🔇 Filtrar spam de NNPACK
            if "NNPACK" in line:
                continue

            # Guardar en buffer global (máx 20)
            log_buffer.append(line)

            # Enviar a colas de clientes conectados
            for q in clients[:]:
                try:
                    q.put_nowait(line)
                except queue.Full:
                    # Si la cola está llena, eliminar el más viejo
                    try:
                        q.get_nowait()
                        q.put_nowait(line)
                    except Exception:
                        if q in clients:
                            clients.remove(q)
                except Exception:
                    if q in clients:
                        clients.remove(q)

    except Exception as e:
        print(f"[ERROR MON] Error leyendo salida: {e}")

    finally:
        if proc.stdout:
            proc.stdout.close()

# --- USUARIO Y CONTRASEÑA ---
USERNAME = "admin"
PASSWORD = "eolo2025"


app = Flask(
    __name__,
    template_folder=os.path.join(BUNDLE_DIR, "templates"),
    static_folder=os.path.join(BUNDLE_DIR, "static")
)


def ejecutar_rtsp_to_mse():
    global rtsp_process
    cwd = STREAM_DIR
    binary_name = "rtsptomse.exe" if os.name == "nt" else "rtsptomse"
    binary_path = os.path.join(cwd, binary_name)

    if rtsp_process and rtsp_process.poll() is None:
        print("Matando proceso anterior de RTSP...")
        rtsp_process.terminate()
        try:
            rtsp_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            rtsp_process.kill()

    if not os.path.exists(binary_path):
        print(f"[WARN] Visualizador MSE no disponible: {binary_path}")
        return

    try:
        # redirigir salida al mismo stdout/stderr
        rtsp_process = subprocess.Popen(
            [binary_path],
            cwd=cwd,
            stdout=sys.stdout,
            stderr=sys.stderr
        )
        print(f"[INFO] rtsptomse.exe iniciado con PID {rtsp_process.pid}")
    except Exception as e:
        print(f"[ERROR] No se pudo iniciar rtsptomse.exe: {e}")


def generar_stream_config():
    """Genera stream/config.json a partir de config.json"""
    # Crear directorio STREAM si no existe
    stream_dir = STREAM_DIR
    os.makedirs(stream_dir, exist_ok=True)
    config_path = os.path.join(stream_dir, "config.json")

    # Cargar config principal
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            main_config = json.load(f)
    except FileNotFoundError:
        print(f"[ERROR] {CONFIG_FILE} no encontrado")
        return

    # Generar streams
    streams = {}
    for cam in main_config.get("cameras", []):
        name = cam.get("name")
        rtsp = cam.get("rtsp")
        if name and rtsp:
            streams[name] = {
                "on_demand": False,
                "url": rtsp
            }

    stream_config = {
        "server": {"http_port": ":8083"},
        "streams": streams
    }

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(stream_config, f, indent=2)

    print(f"[INFO] Archivo de configuración generado en {config_path}")

def check_auth(username, password):
    return username == USERNAME and password == PASSWORD

def authenticate():
    return Response(
        "Acceso restringido", 401,
        {"WWW-Authenticate": 'Basic realm="Login Required"'}
    )

def requires_auth(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or not check_auth(auth.username, auth.password):
            return authenticate()
        return f(*args, **kwargs)
    return decorated


def load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if "barriers" not in data:
                data["barriers"] = [dict(DEMO_BARRIER)]
            if "id_acceso" not in data:
                data["id_acceso"] = ""
            if "id_estacionamiento" not in data:
                data["id_estacionamiento"] = ""
            if "version" not in data:
                data["version"] = "test"
            if "bubble_token" not in data:
                data["bubble_token"] = ""
            return data
    except FileNotFoundError:
        return {"server_url": "", "cameras": [], "barriers": [dict(DEMO_BARRIER)], "id_acceso": "", "id_estacionamiento": "", "version": "test", "bubble_token": ""}

def save_config(config):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)

def restart_main_app():
    global app_process
    # Si ya estaba corriendo, matarlo
    if app_process and app_process.poll() is None:
        print("Matando proceso anterior...")
        app_process.terminate()
        try:
            app_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            app_process.kill()

    # Lanzar de nuevo capturando salida
    print("Iniciando app.py...")
    # -u para unbuffered output
    env = os.environ.copy()
    env["ANPR_DB_FILE"] = DB_FILE
    env["ANPR_CONFIG_FILE"] = CONFIG_FILE
    env["ANPR_CONTROL_BASE_URL"] = ANPR_CONTROL_BASE_URL
    if getattr(sys, "frozen", False):
        command = [sys.executable, "--anpr-worker"]
        cwd = RUNTIME_DIR
    else:
        command = [sys.executable, "-u", MAIN_APP]
        cwd = BASE_DIR
    app_process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        cwd=cwd,
        env=env
    )

    # Hilo para leer logs sin bloquear
    t = threading.Thread(target=monitor_output, args=(app_process,), daemon=True)
    t.start()


def stop_main_app():
    global app_process
    if app_process and app_process.poll() is None:
        app_process.terminate()
        try:
            app_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            app_process.kill()
    return process_status(app_process)


def stop_rtsp_to_mse():
    global rtsp_process
    if rtsp_process and rtsp_process.poll() is None:
        rtsp_process.terminate()
        try:
            rtsp_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            rtsp_process.kill()
    return process_status(rtsp_process)


def process_status(proc):
    if not proc:
        return {"running": False, "pid": None, "exitCode": None}
    code = proc.poll()
    return {"running": code is None, "pid": proc.pid, "exitCode": code}


@app.route("/open/<id_barra>", methods=["POST"])
def open_barrier(id_barra):
    config = load_config()
    barrier = next((b for b in config.get("barriers", []) if b["id_barra"] == id_barra), None)

    if not barrier:
        return jsonify({"error": f"Barrera '{id_barra}' no encontrada"}), 404

    ip_puerto = barrier["ip_puerto"]
    numero_barra = barrier["numero_barra"]
    usuario = barrier["usuario"]
    password = barrier["password"]

    url = f"http://{ip_puerto}/ISAPI/AccessControl/RemoteControl/door/{numero_barra}"
    xml_data = '<?xml version="1.0" encoding="UTF-8"?><RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>'

    try:
        response = requests.put(
            url,
            auth=HTTPDigestAuth(usuario, password),
            data=xml_data,
            headers={"Content-Type": "application/xml"},
            timeout=5
        )
        return jsonify({
            "status": response.status_code,
            "message": "Comando enviado",
            "response": response.text
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/sync_plates", methods=["POST"])
def sync_plates():
    config = load_config()
    id_acceso = config.get("id_acceso")
    if not id_acceso:
        return jsonify({"error": "ID de acceso no configurado"}), 400

    url = f"{URL_GET_PLACAS_RESIDENTES}?acceso={id_acceso}"
    headers = BUBBLE_HEADERS

    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()

        # El formato esperado es response: { placas: "PLACA1|Nombre|Tel,PLACA2|Nombre|Tel" }
        placas_str = data.get("response", {}).get("placas", "")
        items = [p.strip() for p in placas_str.split(",") if p.strip()]

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("DELETE FROM vehiculos")
        for item in items:
            parts = item.split("|")
            placa = parts[0].strip().upper()
            nombre = parts[1].strip() if len(parts) > 1 else ""
            telefono = parts[2].strip() if len(parts) > 2 else ""
            c.execute("INSERT OR IGNORE INTO vehiculos (placa, nombre, telefono) VALUES (?, ?, ?)",
                      (placa, nombre, telefono))

        conn.commit()
        conn.close()

        return jsonify({"message": f"Sincronización exitosa. {len(items)} registros cargados."})
    except Exception as e:
        return jsonify({"error": f"Error en sincronización: {str(e)}"}), 500

@app.route("/acceso_mov_preautorizados", methods=["GET"])
def get_acceso_mov_preautorizados():
    """Obtiene los movimientos preautorizados desde Bubble y los almacena localmente.

    Formato de response.movimientos:
        telefono|id_mov|PLACA1&PLACA2&PLACA3,telefono2|id_mov2|PLACA1&PLACA2
    """
    acceso = request.args.get("acceso")
    if not acceso:
        return jsonify({"error": "Parámetro 'acceso' requerido"}), 400

    url = f"{URL_GET_MOV_PREAUTORIZADOS}?acceso={acceso}"
    headers = BUBBLE_HEADERS

    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()

        # Formato: "telefono|id_mov|PLACA1&PLACA2&PLACA3,telefono2|id_mov2|PLACA1"
        movimientos_str = data.get("response", {}).get("movimientos", "")
        items = [m.strip() for m in movimientos_str.split(",") if m.strip()]

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()

        # Limpiar placas preautorizadas anteriores y los registros Preautorizado pendientes
        c.execute("DELETE FROM placas_preautorizadas")
        c.execute("DELETE FROM movimientos_preautorizados WHERE estatus = 'Preautorizado'")

        total_placas = 0
        for item in items:
            parts = item.split("|")
            if len(parts) < 3:
                continue
            telefono = parts[0].strip()
            id_mov   = parts[1].strip()
            placas_raw = parts[2].strip()

            # Insertar un registro en movimientos_preautorizados por cada id_mov
            # (usamos la primera placa como representativa para la tabla legacy)
            for placa in [p.strip().upper() for p in placas_raw.split("&") if p.strip()]:
                # Tabla nueva: una fila por placa
                c.execute("""
                    INSERT OR IGNORE INTO placas_preautorizadas (placa, telefono, movimiento)
                    VALUES (?, ?, ?)
                """, (placa, telefono, id_mov))

                # Tabla legacy: una fila por placa también, para que app.py la detecte
                c.execute("""
                    INSERT OR IGNORE INTO movimientos_preautorizados (placa, uid_movimiento, estatus)
                    VALUES (?, ?, 'Preautorizado')
                """, (placa, id_mov))

                total_placas += 1

        conn.commit()
        conn.close()

        return jsonify({"message": f"{total_placas} placas preautorizadas cargadas ({len(items)} movimientos).", "movimientos": items})
    except Exception as e:
        return jsonify({"error": f"Error obteniendo preautorizados: {str(e)}"}), 500

def get_base64_image(image_path):
    """Convierte una imagen local a base64 sin prefijo"""
    try:
        full_path = os.path.join("static", image_path)
        if not os.path.exists(full_path):
            return ""
        import base64
        with open(full_path, "rb") as image_file:
            return base64.b64encode(image_file.read()).decode('utf-8')
    except Exception as e:
        print(f"[ERROR B64] {e}")
        return ""

def sync_movements_to_bubble():
    """Busca movimientos no sincronizados y los envía a Bubble"""
    # Evitar múltiples ejecuciones simultáneas
    if not sync_lock.acquire(blocking=False):
        return

    try:
        config = load_config()
        id_acceso = config.get("id_acceso")
        if not id_acceso:
            return

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()

        # Obtener movimientos pendientes de sincronizar
        c.execute("SELECT id, placa, telefono, fecha_entrada, fecha_salida, imagen, uid_bubble, prefijo, folio FROM movimientos_acceso WHERE sync = 0")
        pendientes = c.fetchall()

        for row in pendientes:
            mid, placa, telefono, f_entrada, f_salida, img_path, uid_bubble, pref_cam, folio_num = row

            # Obtener nombre del visitante de la tabla vehiculos
            c.execute("SELECT nombre FROM vehiculos WHERE placa = ?", (placa,))
            res_v = c.fetchone()
            nombre = res_v[0] if res_v else "Residente"

            # Formatear fechas a ISO (Convirtiendo de Local a UTC)
            def to_iso(date_str):
                if not date_str: return None
                try:
                    from datetime import datetime, timezone
                    import time
                    # Asumimos que date_str está en hora local (como se guarda en la DB)
                    dt_local = datetime.strptime(date_str, '%Y-%m-%d %H:%M:%S')
                    # Convertir a timestamp usando la zona horaria local del sistema
                    ts = time.mktime(dt_local.timetuple())
                    # Crear objeto datetime en UTC
                    dt_utc = datetime.fromtimestamp(ts, tz=timezone.utc)
                    return dt_utc.strftime('%Y-%m-%dT%H:%M:%SZ')
                except Exception as e:
                    print(f"[DATE ERROR] {e}")
                    return None

            if not uid_bubble:
                # --- CREAR REGISTRO ---
                url = URL_CREATE_ACCESO_MOV_RESIDENTE
                headers = BUBBLE_HEADERS

                payload = {
                    "NombreVisitante": nombre,
                    "PlacaVisitante": placa,
                    "FechaIngreso": to_iso(f_entrada),
                    "Acceso": id_acceso,
                    "Telefono": telefono,
                    "ImagenEntrada": get_base64_image(img_path) if img_path else "",
                    "Folio": f"{pref_cam or 'CAM'}{folio_num}"
                }

                # Si ya tiene salida (técnica firstOffline con salida rápida)
                if f_salida:
                    payload["FechaSalida"] = to_iso(f_salida)

                try:
                    r = requests.post(url, json=payload, headers=headers, timeout=15)
                    if r.status_code == 200:
                        data = r.json()
                        bubble_id = data.get("response", {}).get("Movimiento", {}).get("_id")
                        if bubble_id:
                            c.execute("UPDATE movimientos_acceso SET sync = 1, uid_bubble = ? WHERE id = ?", (bubble_id, mid))
                            conn.commit()
                            print(f"[SYNC] Movimiento {mid} creado en Bubble: {bubble_id}")
                except Exception as e:
                    print(f"[SYNC ERROR CREATE] {e}")

            else:
                # --- ACTUALIZAR SALIDA ---
                # Si ya tiene UID y tiene fecha_salida, llamamos al endpoint de salida
                if f_salida:
                    url = URL_SALIDA_ACCESO
                    headers = BUBBLE_HEADERS

                    # Necesitamos la imagen de salida
                    c.execute("SELECT imagen_salida FROM movimientos_acceso WHERE id = ?", (mid,))
                    img_salida_path = c.fetchone()[0]

                    payload = {
                        "AccesoMov": uid_bubble,
                        "FechaSalida": to_iso(f_salida),
                        "ImagenSalida": get_base64_image(img_salida_path) if img_salida_path else ""
                    }

                    try:
                        r = requests.post(url, json=payload, headers=headers, timeout=15)
                        if r.status_code == 200:
                            c.execute("UPDATE movimientos_acceso SET sync = 1 WHERE id = ?", (mid,))
                            conn.commit()
                            print(f"[SYNC] Salida de movimiento {mid} sincronizada en Bubble")
                    except Exception as e:
                        print(f"[SYNC ERROR SALIDA] {e}")
                else:
                    # Si no tiene fecha_salida pero ya tiene UID, marcar como sync=1 (ya se creó la entrada)
                    c.execute("UPDATE movimientos_acceso SET sync = 1 WHERE id = ?", (mid,))
                    conn.commit()

        conn.close()
    except Exception as e:
        print(f"[SYNC ERROR GLOBAL] {e}")
    finally:
        sync_lock.release()

def sync_preautorizados_to_bubble():
    """Envía a Bubble los movimientos preautorizados que se ingresaron offline"""
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("""
            SELECT id, uid_movimiento, camara_ingreso, imagen_ingreso
            FROM movimientos_preautorizados
            WHERE estatus = 'Ingresado' AND sync = 0
        """)
        pendientes = c.fetchall()

        for row in pendientes:
            pid, uid_mov, camara, imagen_ingreso = row

            # Obtener todas las placas asociadas a este movimiento desde placas_preautorizadas
            c.execute("""
                SELECT placa FROM placas_preautorizadas
                WHERE movimiento = ?
            """, (uid_mov,))
            placas_rows = c.fetchall()
            placas_str = "&".join([r[0] for r in placas_rows]) if placas_rows else ""

            url = URL_ENTRADA_ACCESO_PREAUTORIZADO
            headers = BUBBLE_HEADERS
            payload = {
                "acceso_mov": uid_mov,
                "camara": camara or "",
                "placa": placas_str,
                "imagen": get_base64_image(imagen_ingreso) if imagen_ingreso else ""
            }
            try:
                r = requests.post(url, json=payload, headers=headers, timeout=15)
                if r.status_code == 200:
                    c.execute("UPDATE movimientos_preautorizados SET sync = 1 WHERE id = ?", (pid,))
                    conn.commit()
                    print(f"[SYNC PREAUT] Movimiento {uid_mov} sincronizado. Placas: {placas_str}")
            except Exception as e:
                print(f"[SYNC PREAUT ERROR] {e}")

        conn.close()
    except Exception as e:
        print(f"[SYNC PREAUT GLOBAL ERROR] {e}")

_preaut_counter = 0

def sync_exentos_to_bubble():
    """Envía a Bubble las salidas por exento de estacionamiento pendientes de sincronizar"""
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("""
            SELECT id, placa, id_movimiento_reserva, imagen_salida
            FROM movimientos_estacionamiento
            WHERE sync = 0
        """)
        pendientes = c.fetchall()

        for row in pendientes:
            mid, placa, id_reserva, imagen_salida = row
            payload = {
                "reserva": id_reserva
            }
            try:
                r = requests.post(URL_APK_SALIDA_RESERVA, json=payload, headers=BUBBLE_HEADERS, timeout=15)
                if r.status_code == 200:
                    c.execute("UPDATE movimientos_estacionamiento SET sync = 1 WHERE id = ?", (mid,))
                    conn.commit()
                    print(f"[SYNC EXENTO] Reserva {id_reserva} ({placa}) sincronizada.")
            except Exception as e:
                print(f"[SYNC EXENTO ERROR] {e}")

        conn.close()
    except Exception as e:
        print(f"[SYNC EXENTO GLOBAL ERROR] {e}")

def sync_cobros_inventario_to_bubble():
    """Envía a Bubble los cobros de inventario pendientes de sincronizar"""
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("""
            SELECT id, uid_reserva, id_wallet, monto_saldo, monto_reserva, monto_total
            FROM cobros_inventario
            WHERE sync = 0
        """)
        pendientes = c.fetchall()
        print(f"[SYNC COBRO] {len(pendientes)} cobros pendientes de sincronizar.")

        for row in pendientes:
            cid, uid_reserva, id_wallet, monto_saldo, monto_reserva, monto_total = row
            payload = {
                "monto_saldo": float(monto_saldo),
                "wallet": id_wallet,
                "montoreserva": float(monto_reserva),
                "metodopago1": "Saldo",
                "tipotarjeta": "Débito",
                "monto1": float(monto_total),
                "monto2": 0,
                "reserva": uid_reserva
            }
            try:
                print(f"[SYNC COBRO] Enviando payload: {payload}")
                r = requests.post(URL_APK_COBRAR, json=payload, headers=BUBBLE_HEADERS, timeout=15)
                print(f"[SYNC COBRO] status={r.status_code} body={r.text[:300]}")
                if r.status_code == 200:
                    c.execute("UPDATE cobros_inventario SET sync = 1 WHERE id = ?", (cid,))
                    conn.commit()
                    print(f"[SYNC COBRO] Cobro de reserva {uid_reserva} sincronizado.")
                else:
                    print(f"[SYNC COBRO ERROR] Bubble respondio {r.status_code} para reserva {uid_reserva}: {r.text[:500]}")
            except Exception as e:
                import traceback
                print(f"[SYNC COBRO ERROR] Excepcion al enviar cobro id={cid}: {e}")
                print(traceback.format_exc())

        conn.close()
    except Exception as e:
        import traceback
        print(f"[SYNC COBRO GLOBAL ERROR] {e}")
        print(traceback.format_exc())

def background_worker(stop_event=None):
    """Hilo secundario para sincronización cada 10 segundos"""
    global _preaut_counter
    stop_event = stop_event or threading.Event()
    print("[WORKER] Iniciando hilo de sincronización...")
    while not stop_event.is_set():
        try:
            # 1. Sincronizar placas (reutilizando la lógica interna de sync_plates)
            with app.test_request_context():
                sync_plates()

            # 2. Sincronizar movimientos
            sync_movements_to_bubble()

            # 3. Sincronizar preautorizados pendientes (offline → online)
            sync_preautorizados_to_bubble()

            # 4. Obtener preautorizados de Bubble cada 30 s (cada 3 ciclos de 10 s)
            _preaut_counter += 1
            if _preaut_counter >= 3:
                _preaut_counter = 0
                config = load_config()
                id_acceso = config.get("id_acceso", "")

                # --- Preautorizados ---
                if id_acceso:
                    with app.test_request_context():
                        # Reutilizar la lógica del endpoint GET
                        url = f"{URL_GET_MOV_PREAUTORIZADOS}?acceso={id_acceso}"
                        headers = BUBBLE_HEADERS
                        try:
                            resp = requests.get(url, headers=headers, timeout=10)
                            if resp.status_code == 200:
                                data = resp.json()
                                # Nuevo formato: "telefono|id_mov|PLACA1&PLACA2,telefono2|id_mov2|PLACA3"
                                movimientos_str = data.get("response", {}).get("movimientos", "")
                                items = [m.strip() for m in movimientos_str.split(",") if m.strip()]
                                conn = sqlite3.connect(DB_FILE)
                                c = conn.cursor()
                                c.execute("DELETE FROM placas_preautorizadas")
                                c.execute("DELETE FROM movimientos_preautorizados WHERE estatus = 'Preautorizado'")
                                total_placas = 0
                                for item in items:
                                    parts = item.split("|")
                                    if len(parts) < 3:
                                        continue
                                    telefono  = parts[0].strip()
                                    id_mov    = parts[1].strip()
                                    placas_raw = parts[2].strip()
                                    for placa in [p.strip().upper() for p in placas_raw.split("&") if p.strip()]:
                                        c.execute("""
                                            INSERT OR IGNORE INTO placas_preautorizadas (placa, telefono, movimiento)
                                            VALUES (?, ?, ?)
                                        """, (placa, telefono, id_mov))
                                        c.execute("""
                                            INSERT OR IGNORE INTO movimientos_preautorizados (placa, uid_movimiento, estatus)
                                            VALUES (?, ?, 'Preautorizado')
                                        """, (placa, id_mov))
                                        total_placas += 1
                                conn.commit()
                                conn.close()
                                print(f"[WORKER] {total_placas} placas preautorizadas actualizadas ({len(items)} movimientos).")
                        except Exception as e:
                            print(f"[WORKER PREAUT ERROR] {e}")

        except Exception as e:
            print(f"[WORKER ERROR] {e}")

        stop_event.wait(10)

    print("[WORKER] Hilo de sincronización detenido.")


def start_background_worker():
    global worker_thread, worker_stop_event, worker_started_at
    if worker_thread and worker_thread.is_alive():
        return sync_worker_status()

    worker_stop_event = threading.Event()
    worker_thread = threading.Thread(target=background_worker, args=(worker_stop_event,), daemon=True)
    worker_thread.start()
    worker_started_at = time.strftime('%Y-%m-%d %H:%M:%S')
    return sync_worker_status()


def stop_background_worker():
    global worker_thread
    if worker_thread and worker_thread.is_alive():
        worker_stop_event.set()
        worker_thread.join(timeout=5)
    return sync_worker_status()


def sync_worker_status():
    return {
        "running": bool(worker_thread and worker_thread.is_alive()),
        "startedAt": worker_started_at
    }

# Eliminar el inicio automático aquí para evitar duplicados con el reloader de Flask
# threading.Thread(target=background_worker, daemon=True).start()

@app.route("/exentos_estacionamiento", methods=["GET"])
def get_exentos_estacionamiento():
    """Obtiene los exentos de estacionamiento desde Bubble (Placa|ID_Movimiento) y los almacena localmente."""
    estacionamiento = request.args.get("estacionamiento")
    if not estacionamiento:
        config = load_config()
        estacionamiento = config.get("id_estacionamiento", "")
    if not estacionamiento:
        return jsonify({"error": "Par\u00e1metro 'estacionamiento' requerido"}), 400

    url = f"{URL_GET_EXENTOS_ESTACIONAMIENTO}?estacionamiento={estacionamiento}"
    try:
        response = requests.get(url, headers=BUBBLE_HEADERS, timeout=10)
        response.raise_for_status()
        data = response.json()

        movimientos_str = data.get("response", {}).get("movimientos", "")
        items = [m.strip() for m in movimientos_str.split(",") if m.strip()]

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("DELETE FROM exentos_estacionamiento WHERE estatus = 'Pendiente'")
        total = 0
        for item in items:
            parts = item.split("|")
            if len(parts) < 2:
                continue
            placa  = parts[0].strip().upper()
            id_mov = parts[1].strip()
            c.execute("""
                INSERT OR IGNORE INTO exentos_estacionamiento (placa, id_movimiento, estatus)
                VALUES (?, ?, 'Pendiente')
            """, (placa, id_mov))
            total += 1
        conn.commit()
        conn.close()
        return jsonify({"message": f"{total} exentos cargados.", "movimientos": items})
    except Exception as e:
        return jsonify({"error": f"Error obteniendo exentos: {str(e)}"}), 500

@app.route("/exentos_estacionamiento/sync", methods=["POST"])
def sync_exentos_manual():
    """Actualiza manualmente los exentos desde Bubble y redirige a la página de estacionamiento"""
    config = load_config()
    estacionamiento = config.get("id_estacionamiento", "")
    if estacionamiento:
        url = f"{URL_GET_EXENTOS_ESTACIONAMIENTO}?estacionamiento={estacionamiento}"
        try:
            resp = requests.get(url, headers=BUBBLE_HEADERS, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                movs_str = data.get("response", {}).get("movimientos", "")
                items = [m.strip() for m in movs_str.split(",") if m.strip()]
                conn = sqlite3.connect(DB_FILE)
                c = conn.cursor()
                c.execute("DELETE FROM exentos_estacionamiento WHERE estatus = 'Pendiente'")
                for item in items:
                    parts = item.split("|")
                    if len(parts) < 2:
                        continue
                    placa  = parts[0].strip().upper()
                    id_mov = parts[1].strip()
                    c.execute("""
                        INSERT OR IGNORE INTO exentos_estacionamiento (placa, id_movimiento, estatus)
                        VALUES (?, ?, 'Pendiente')
                    """, (placa, id_mov))
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"[SYNC MANUAL EXENTO ERROR] {e}")

        # Sync manual inventario
        url_inv = f"{URL_GET_PLACAS_INVENTARIO}?estacionamiento={estacionamiento}"
        try:
            resp_inv = requests.get(url_inv, headers=BUBBLE_HEADERS, timeout=10)
            if resp_inv.status_code == 200:
                data_inv = resp_inv.json()
                inv_str = data_inv.get("response", {}).get("movimientos", "")
                items_inv = [m.strip() for m in inv_str.split(",") if m.strip()]
                conn = sqlite3.connect(DB_FILE)
                c = conn.cursor()
                c.execute("DELETE FROM inventario_estacionamiento")
                for item in items_inv:
                    parts = item.split("|")
                    if len(parts) < 7:
                        continue
                    uid_reserva        = parts[0].strip()
                    placa              = parts[1].strip().upper()
                    id_wallet          = parts[2].strip()
                    balance_wallet     = float(parts[3].strip() or 0)
                    total_por_pagar    = float(parts[4].strip() or 0)
                    por_pagar_reserva  = float(parts[5].strip() or 0)
                    por_pagar_servicio = float(parts[6].strip() or 0)
                    c.execute("""
                        INSERT OR IGNORE INTO inventario_estacionamiento (
                            uid_reserva, placa, id_wallet, balance_wallet,
                            total_por_pagar, por_pagar_reserva, por_pagar_servicio
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """, (uid_reserva, placa, id_wallet, balance_wallet, total_por_pagar, por_pagar_reserva, por_pagar_servicio))
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"[SYNC MANUAL INVENTARIO ERROR] {e}")

    return redirect(url_for("view_estacionamiento"))

@app.route("/estacionamiento", methods=["GET", "POST"])
def view_estacionamiento():
    """Página de visualización de exentos de estacionamiento"""
    config = load_config()

    # Manejar guardado de id_estacionamiento
    if request.method == "POST":
        id_estacionamiento = request.form.get("id_estacionamiento")
        if id_estacionamiento is not None:
            config["id_estacionamiento"] = id_estacionamiento.strip()
            save_config(config)
        return redirect(url_for("view_estacionamiento"))

    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()

        c.execute("SELECT placa, id_movimiento FROM exentos_estacionamiento WHERE estatus = 'Pendiente' ORDER BY id")
        exentos_pendientes = [{"placa": r[0], "id_movimiento": r[1]} for r in c.fetchall()]

        c.execute("SELECT placa, id_movimiento FROM exentos_estacionamiento WHERE estatus = 'Usado' ORDER BY id DESC LIMIT 200")
        exentos_usados = [{"placa": r[0], "id_movimiento": r[1]} for r in c.fetchall()]

        c.execute("""
            SELECT placa, id_estacionamiento, id_movimiento_reserva, fecha_salida, camara_salida, imagen_salida, sync
            FROM movimientos_estacionamiento
            ORDER BY fecha_salida DESC LIMIT 200
        """)
        movimientos = [
            {
                "placa": r[0],
                "id_estacionamiento": r[1],
                "id_movimiento_reserva": r[2],
                "fecha_salida": r[3],
                "camara_salida": r[4],
                "imagen_salida": r[5],
                "sync": r[6],
            }
            for r in c.fetchall()
        ]
        c.execute("""
            SELECT uid_reserva, placa, id_wallet, balance_wallet, total_por_pagar, por_pagar_reserva, por_pagar_servicio
            FROM inventario_estacionamiento
            ORDER BY id
        """)
        inventario_estacionamiento = [
            {
                "uid_reserva": r[0],
                "placa": r[1],
                "id_wallet": r[2],
                "balance_wallet": r[3],
                "total_por_pagar": r[4],
                "por_pagar_reserva": r[5],
                "por_pagar_servicio": r[6],
            }
            for r in c.fetchall()
        ]

        c.execute("""
            SELECT uid_reserva, placa, monto_total, sync
            FROM cobros_inventario
            ORDER BY id DESC LIMIT 200
        """)
        cobros_inventario = [
            {
                "uid_reserva": r[0],
                "placa": r[1],
                "monto_total": r[2],
                "sync": r[3],
            }
            for r in c.fetchall()
        ]

        conn.close()

        app_running = app_process is not None and app_process.poll() is None
        return render_template(
            "estacionamiento.html",
            exentos_pendientes=exentos_pendientes,
            exentos_usados=exentos_usados,
            movimientos=movimientos,
            inventario_estacionamiento=inventario_estacionamiento,
            cobros_inventario=cobros_inventario,
            app_running=app_running,
            id_estacionamiento=config.get("id_estacionamiento", "")
        )
    except Exception as e:
        return f"Error al cargar estacionamiento: {e}", 500

@app.route("/api/sync_now", methods=["POST"])
def sync_now():
    """Endpoint para forzar una sincronización inmediata"""
    try:
        sync_movements_to_bubble()
        sync_preautorizados_to_bubble()
        return jsonify({"status": "success", "parking_sync": "disabled", "cobros_sync": "disabled"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def service_status_payload():
    return {
        "anpr-processor": {
            "id": "anpr-processor",
            "name": "Procesador ANPR",
            **process_status(app_process)
        },
        "rtsp-preview": {
            "id": "rtsp-preview",
            "name": "Visualizador Cámaras",
            **process_status(rtsp_process)
        },
        "visit-sync": {
            "id": "visit-sync",
            "name": "Visitas Sync",
            **sync_worker_status()
        }
    }


def mask_rtsp_url(value):
    if not value:
        return ""
    text = str(value)
    if "@" not in text:
        return text
    scheme, rest = text.split("://", 1) if "://" in text else ("", text)
    host = rest.split("@", 1)[1]
    return f"{scheme}://***:***@{host}" if scheme else f"***:***@{host}"


def safe_config_payload(config):
    barriers = config.get("barriers", [])
    barrier_ids = {barrier.get("id_barra") for barrier in barriers if barrier.get("id_barra")}

    cameras = []
    for camera in config.get("cameras", []):
        rtsp = camera.get("rtsp", camera.get("rtsp_url", ""))
        linked_ids = camera_barrier_ids(camera, barriers, barrier_ids)
        cameras.append({
            "name": camera.get("name", ""),
            "type": camera.get("type", ""),
            "prefix": camera.get("prefix", ""),
            "rtsp_url": mask_rtsp_url(rtsp),
            "has_rtsp": bool(rtsp),
            "barrier_ids": linked_ids,
            "barrier_count": len(linked_ids),
        })

    public_barriers = []
    for barrier in barriers:
        public_barriers.append({
            "id_barra": barrier.get("id_barra", ""),
            "numero_barra": barrier.get("numero_barra", ""),
            "ip_puerto": barrier.get("ip_puerto", ""),
            "usuario": barrier.get("usuario", ""),
            "camera_name": barrier.get("camera_name", ""),
            "password_set": bool(barrier.get("password")),
        })

    return {
        "server_url": config.get("server_url", ""),
        "version": config.get("version", "test"),
        "bubble_token_set": bool(config.get("bubble_token")),
        "id_acceso": config.get("id_acceso", ""),
        "min_plate_width_ratio": config.get("min_plate_width_ratio", 0.02),
        "min_plate_height_ratio": config.get("min_plate_height_ratio", 0.02),
        "strict_plate_validation": bool(config.get("strict_plate_validation", True)),
        "require_vehicle_detection": bool(config.get("require_vehicle_detection", False)),
        "min_vehicle_confidence": config.get("min_vehicle_confidence", 0.78),
        "cameras": cameras,
        "barriers": public_barriers,
    }


def camera_barrier_ids(camera, barriers, barrier_ids=None):
    if barrier_ids is None:
        barrier_ids = {barrier.get("id_barra") for barrier in barriers if barrier.get("id_barra")}
    linked_ids = []
    for value in camera.get("barrier_ids", []) or []:
        b_id = str(value).strip()
        if b_id and b_id in barrier_ids and b_id not in linked_ids:
            linked_ids.append(b_id)
    camera_name = camera.get("name", "")
    for barrier in barriers:
        b_id = barrier.get("id_barra")
        if b_id and barrier.get("camera_name") == camera_name and b_id not in linked_ids:
            linked_ids.append(b_id)
    return linked_ids


def normalize_hardware_payload(payload):
    import random, string

    def gen_prefix():
        return ''.join(random.choices(string.ascii_uppercase, k=3))

    barrier_ids = {
        str(raw.get("id_barra", "")).strip()
        for raw in payload.get("barriers", [])
        if str(raw.get("id_barra", "")).strip()
    }

    cameras = []
    for raw in payload.get("cameras", []):
        name = str(raw.get("name", "")).strip()
        rtsp = str(raw.get("rtsp", raw.get("rtsp_url", ""))).strip()
        if not name and not rtsp:
            continue
        if not name or not rtsp:
            raise ValueError("Cada camara requiere nombre y URL RTSP.")
        c_type = raw.get("type", "Entrada")
        prefix = str(raw.get("prefix", "") or gen_prefix()).strip().upper()[:3]
        linked_barrier_ids = []
        for value in raw.get("barrier_ids", []) or []:
            b_id = str(value).strip()
            if b_id and b_id in barrier_ids and b_id not in linked_barrier_ids:
                linked_barrier_ids.append(b_id)
        cameras.append({
            "name": name,
            "rtsp": rtsp,
            "type": c_type if c_type in {"Entrada", "Salida"} else "Entrada",
            "prefix": prefix,
            "barrier_ids": linked_barrier_ids
        })

    barriers = []
    for raw in payload.get("barriers", []):
        b_id = str(raw.get("id_barra", "")).strip()
        if not b_id:
            continue
        barriers.append({
            "id_barra": b_id,
            "numero_barra": str(raw.get("numero_barra", "")).strip(),
            "ip_puerto": str(raw.get("ip_puerto", "")).strip(),
            "usuario": str(raw.get("usuario", "")).strip(),
            "password": str(raw.get("password", "")).strip(),
            "camera_name": ""
        })

    return cameras, barriers


def public_hardware_payload(config):
    barriers = config.get("barriers", [])
    barrier_ids = {barrier.get("id_barra") for barrier in barriers if barrier.get("id_barra")}
    return {
        "cameras": [
            {
                "name": camera.get("name", ""),
                "type": camera.get("type", "Entrada"),
                "prefix": camera.get("prefix", ""),
                "rtsp": camera.get("rtsp", camera.get("rtsp_url", "")),
                "barrier_ids": camera_barrier_ids(camera, barriers, barrier_ids),
            }
            for camera in config.get("cameras", [])
        ],
        "barriers": [
            {
                "id_barra": barrier.get("id_barra", ""),
                "numero_barra": barrier.get("numero_barra", ""),
                "ip_puerto": barrier.get("ip_puerto", ""),
                "usuario": barrier.get("usuario", ""),
                "password": barrier.get("password", ""),
                "camera_name": barrier.get("camera_name", ""),
            }
            for barrier in config.get("barriers", [])
        ],
    }


def public_config_payload(config):
    return {
        "server_url": config.get("server_url", ""),
        "version": config.get("version", "test"),
        "bubble_token_set": bool(config.get("bubble_token")),
        "id_acceso": config.get("id_acceso", ""),
        "min_plate_width_ratio": config.get("min_plate_width_ratio", 0.02),
        "min_plate_height_ratio": config.get("min_plate_height_ratio", 0.02),
        "strict_plate_validation": bool(config.get("strict_plate_validation", True)),
        "require_vehicle_detection": bool(config.get("require_vehicle_detection", False)),
        "min_vehicle_confidence": config.get("min_vehicle_confidence", 0.78),
    }


def apply_config_payload(config, payload):
    if "server_url" in payload:
        config["server_url"] = str(payload.get("server_url", "")).strip()
    if payload.get("version") in {"test", "live"}:
        config["version"] = payload.get("version")
    if "bubble_token" in payload:
        config["bubble_token"] = str(payload.get("bubble_token", "")).strip()
    if "id_acceso" in payload:
        config["id_acceso"] = str(payload.get("id_acceso", "")).strip()

    numeric_fields = {
        "min_plate_width_ratio": (0, 1),
        "min_plate_height_ratio": (0, 1),
        "min_vehicle_confidence": (0, 1),
    }
    for field, (min_value, max_value) in numeric_fields.items():
        if field not in payload:
            continue
        try:
            value = float(payload.get(field))
        except (TypeError, ValueError):
            raise ValueError(f"{field} debe ser numerico.")
        if value < min_value or value > max_value:
            raise ValueError(f"{field} debe estar entre {min_value} y {max_value}.")
        config[field] = value

    if "require_vehicle_detection" in payload:
        config["require_vehicle_detection"] = bool(payload.get("require_vehicle_detection"))
    if "strict_plate_validation" in payload:
        config["strict_plate_validation"] = bool(payload.get("strict_plate_validation"))

    return config


def query_dicts(cursor, sql, params=()):
    cursor.execute(sql, params)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def scalar(cursor, sql, params=()):
    cursor.execute(sql, params)
    row = cursor.fetchone()
    return row[0] if row else 0


def now_local():
    return time.strftime('%Y-%m-%d %H:%M:%S')


def normalize_status(row):
    if row.get("fecha_salida"):
        return "Egresado"
    if row.get("fecha_entrada"):
        return "Ingresado"
    return "Solicitado"


def normalize_kind(value):
    value = (value or "").strip().lower()
    if value in ["peaton", "pedestrian"]:
        return "Peaton"
    return "Vehiculo"


def clean_text(value, fallback=""):
    return str(value if value is not None else fallback).strip()


def operator_movement_payload(row):
    status = normalize_status(row)
    kind = normalize_kind(row.get("person_type"))
    prefijo = row.get("prefijo") or "AC"
    folio = row.get("folio")
    folio_display = f"{prefijo}{folio}" if folio else row.get("uid_bubble") or f"LOCAL-{row.get('id')}"
    return {
        **row,
        "status": status,
        "kind": kind,
        "folio_display": folio_display,
        "can_enter": status == "Solicitado",
        "can_exit": status == "Ingresado",
        "can_edit": status != "Egresado"
    }


def operator_select_sql(where_sql=""):
    return f"""
        SELECT id, folio, placa, telefono, id_acceso, fecha_entrada, fecha_salida,
               camara_entrada, camara_salida, imagen, imagen_salida, sync, uid_bubble,
               prefijo, created_at, updated_at, visitor_name, notes, movement_type,
               person_type, vehicle_type, vehicle_category, economic_number, brand,
               model, vehicle_year, color, short_description, visit_to, area, contact,
               operator_name, last_operator, inspection_notes
        FROM movimientos_acceso
        {where_sql}
    """


def fetch_operator_movement(cursor, movement_id):
    rows = query_dicts(
        cursor,
        operator_select_sql("WHERE id = ?"),
        (movement_id,)
    )
    return operator_movement_payload(rows[0]) if rows else None


def dashboard_database_payload():
    payload = {
        "access": {
            "movements": [],
            "plates": [],
            "plate_count": 0,
            "pending_sync_count": 0,
        }
    }

    conn = sqlite3.connect(DB_FILE)
    try:
        cursor = conn.cursor()
        payload["access"]["movements"] = query_dicts(cursor, """
            SELECT folio, placa, telefono, id_acceso, fecha_entrada, fecha_salida,
                   camara_entrada, camara_salida, sync, uid_bubble, prefijo
            FROM movimientos_acceso
            ORDER BY fecha_entrada DESC
            LIMIT 80
        """)
        payload["access"]["plates"] = query_dicts(cursor, """
            SELECT placa, nombre, telefono
            FROM vehiculos
            ORDER BY placa
            LIMIT 80
        """)
        payload["access"]["plate_count"] = scalar(cursor, "SELECT COUNT(*) FROM vehiculos")
        payload["access"]["pending_sync_count"] = scalar(
            cursor,
            "SELECT COUNT(*) FROM movimientos_acceso WHERE COALESCE(sync, 0) = 0"
        )

    finally:
        conn.close()

    return payload


@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({
        "ok": True,
        "service": "anpr-eolo",
        "port": ANPR_API_PORT,
        "dbFile": DB_FILE,
        "configFile": CONFIG_FILE,
        "services": service_status_payload()
    })


@app.route("/api/services", methods=["GET"])
def api_services():
    return jsonify({"services": list(service_status_payload().values())})


@app.route("/api/anpr/detections", methods=["GET"])
def api_anpr_detections():
    try:
        with open(DETECTIONS_FILE, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except FileNotFoundError:
        payload = {"updated_at": None, "detections": {}}
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "detections": {}}), 500
    return jsonify({"ok": True, **payload})


@app.route("/api/anpr/status", methods=["GET"])
def api_anpr_status():
    try:
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except FileNotFoundError:
        payload = {"updated_at": None, "cameras": {}}
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "cameras": {}}), 500
    return jsonify({"ok": True, **payload})


@app.route("/api/anpr/snapshots/<camera_name>", methods=["GET"])
def api_anpr_snapshot(camera_name):
    safe_name = "".join(ch if ch.isalnum() or ch in "_.-" else "_" for ch in camera_name).strip("._")
    file_path = os.path.join(SNAPSHOT_DIR, f"{safe_name or 'camera'}.jpg")
    if not os.path.exists(file_path):
        return jsonify({"ok": False, "error": "Snapshot no disponible para esta camara."}), 404
    return send_file(file_path, mimetype="image/jpeg", max_age=0)


@app.route("/api/dashboard", methods=["GET"])
def api_dashboard():
    config = load_config()
    payload = {
        "ok": True,
        "service": "anpr-eolo",
        "port": ANPR_API_PORT,
        "db_file": DB_FILE,
        "config_file": CONFIG_FILE,
        "config": safe_config_payload(config),
        "services": service_status_payload(),
        "logs": list(log_buffer),
    }

    try:
        payload.update(dashboard_database_payload())
    except Exception as e:
        payload["db_error"] = str(e)

    return jsonify(payload)


@app.route("/api/operator/movements", methods=["GET"])
def api_operator_movements():
    movement_date = request.args.get("date") or time.strftime('%Y-%m-%d')
    access = clean_text(request.args.get("access"))
    search = clean_text(request.args.get("search")).lower()
    status_filter = clean_text(request.args.get("status"))
    kind_filter = clean_text(request.args.get("kind"))

    params = [f"{movement_date}%", f"{movement_date}%", f"{movement_date}%"]
    where = [
        "(COALESCE(fecha_entrada, '') LIKE ? OR COALESCE(fecha_salida, '') LIKE ? OR COALESCE(created_at, '') LIKE ?)"
    ]
    if access:
        where.append("id_acceso = ?")
        params.append(access)

    conn = sqlite3.connect(DB_FILE)
    try:
        cursor = conn.cursor()
        rows = query_dicts(
            cursor,
            operator_select_sql(f"WHERE {' AND '.join(where)} ORDER BY COALESCE(fecha_entrada, created_at) DESC, id DESC LIMIT 300"),
            tuple(params)
        )
        movements = [operator_movement_payload(row) for row in rows]
        if search:
            movements = [
                item for item in movements
                if search in " ".join([
                    clean_text(item.get("visitor_name")),
                    clean_text(item.get("folio_display")),
                    clean_text(item.get("placa")),
                    clean_text(item.get("notes")),
                    clean_text(item.get("area")),
                    clean_text(item.get("visit_to"))
                ]).lower()
            ]
        if status_filter:
            movements = [item for item in movements if item["status"].lower() == status_filter.lower()]
        if kind_filter:
            movements = [item for item in movements if item["kind"].lower() == kind_filter.lower()]

        vehicle_active = len([m for m in movements if m["kind"] == "Vehiculo" and m["status"] == "Ingresado"])
        pedestrian_active = len([m for m in movements if m["kind"] == "Peaton" and m["status"] == "Ingresado"])
        pending_sync = scalar(cursor, "SELECT COUNT(*) FROM movimientos_acceso WHERE COALESCE(sync, 0) = 0")
        return jsonify({
            "ok": True,
            "date": movement_date,
            "movements": movements,
            "summary": {
                "vehicles": vehicle_active,
                "pedestrians": pedestrian_active,
                "total": len(movements),
                "pending_sync": pending_sync
            }
        })
    finally:
        conn.close()


@app.route("/api/operator/movements", methods=["POST"])
def api_operator_create_movement():
    payload = request.get_json(silent=True) or {}
    kind = normalize_kind(payload.get("kind"))
    placa = clean_text(payload.get("placa")).upper()
    visitor_name = clean_text(payload.get("visitor_name"))
    status = clean_text(payload.get("status"), "Ingresado")
    config = load_config()
    id_acceso = clean_text(payload.get("id_acceso"), config.get("id_acceso", ""))

    if kind == "Vehiculo" and not placa:
        return jsonify({"ok": False, "error": "Las placas son obligatorias para movimientos vehiculares."}), 400
    if not visitor_name:
        return jsonify({"ok": False, "error": "El nombre del visitante es obligatorio."}), 400
    if status not in ["Solicitado", "Ingresado"]:
        return jsonify({"ok": False, "error": "Solo se puede crear un movimiento solicitado o ingresado."}), 400

    conn = sqlite3.connect(DB_FILE)
    try:
        cursor = conn.cursor()
        if kind == "Vehiculo" and status == "Ingresado":
            cursor.execute(
                "SELECT id FROM movimientos_acceso WHERE placa = ? AND fecha_entrada IS NOT NULL AND fecha_salida IS NULL",
                (placa,)
            )
            if cursor.fetchone():
                return jsonify({"ok": False, "error": "La placa ya tiene un movimiento ingresado activo."}), 409

        cursor.execute("SELECT MAX(folio) FROM movimientos_acceso")
        next_folio = (cursor.fetchone()[0] or 0) + 1
        timestamp = now_local()
        fecha_entrada = timestamp if status == "Ingresado" else None
        prefijo = clean_text(payload.get("prefijo"), "AC")
        sync_value = 0 if fecha_entrada else 1
        entry_image = clean_text(
            payload.get("image")
            or payload.get("imagen")
            or payload.get("vehicle_photo_url")
            or payload.get("entry_image_url")
            or payload.get("vehicle_photo_data_url")
            or payload.get("entry_photo_data_url")
        )

        cursor.execute("""
            INSERT INTO movimientos_acceso (
                folio, placa, telefono, id_acceso, fecha_entrada, fecha_salida,
                camara_entrada, camara_salida, imagen, imagen_salida, sync, uid_bubble,
                prefijo, created_at, updated_at, visitor_name, notes, movement_type,
                person_type, vehicle_type, vehicle_category, economic_number, brand,
                model, vehicle_year, color, short_description, visit_to, area, contact,
                operator_name, last_operator, inspection_notes
            )
            VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, NULL,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            next_folio,
            placa if kind == "Vehiculo" else "",
            clean_text(payload.get("telefono")),
            id_acceso,
            fecha_entrada,
            clean_text(payload.get("camera")),
            entry_image,
            sync_value,
            prefijo,
            timestamp,
            timestamp,
            visitor_name,
            clean_text(payload.get("notes")),
            clean_text(payload.get("movement_type"), "Visita"),
            kind,
            clean_text(payload.get("vehicle_type"), "Automovil"),
            clean_text(payload.get("vehicle_category"), "Sedan"),
            clean_text(payload.get("economic_number")),
            clean_text(payload.get("brand")),
            clean_text(payload.get("model")),
            clean_text(payload.get("vehicle_year")),
            clean_text(payload.get("color")),
            clean_text(payload.get("short_description")),
            clean_text(payload.get("visit_to")),
            clean_text(payload.get("area")),
            clean_text(payload.get("contact")),
            clean_text(payload.get("operator_name")),
            clean_text(payload.get("operator_name")),
            clean_text(payload.get("inspection_notes"))
        ))
        movement_id = cursor.lastrowid
        conn.commit()
        movement = fetch_operator_movement(cursor, movement_id)
        return jsonify({"ok": True, "movement": movement}), 201
    finally:
        conn.close()


@app.route("/api/operator/movements/<int:movement_id>", methods=["PATCH"])
def api_operator_update_movement(movement_id):
    payload = request.get_json(silent=True) or {}
    action = clean_text(payload.get("action"), "update")
    conn = sqlite3.connect(DB_FILE)
    try:
        cursor = conn.cursor()
        movement = fetch_operator_movement(cursor, movement_id)
        if not movement:
            return jsonify({"ok": False, "error": "Movimiento no encontrado."}), 404

        status = movement["status"]
        timestamp = now_local()

        if action == "egress":
            if status != "Ingresado":
                return jsonify({"ok": False, "error": "Solo se puede dar salida a un movimiento con estatus Ingresado."}), 409
            cursor.execute("""
                UPDATE movimientos_acceso
                SET fecha_salida = ?, camara_salida = ?, imagen_salida = COALESCE(imagen_salida, ?),
                    sync = 0, updated_at = ?, last_operator = ?
                WHERE id = ?
            """, (
                timestamp,
                clean_text(payload.get("camera")),
                clean_text(payload.get("image")),
                timestamp,
                clean_text(payload.get("operator_name")),
                movement_id
            ))
        elif action == "ingress":
            if status != "Solicitado":
                return jsonify({"ok": False, "error": "Solo se puede registrar entrada a una solicitud pendiente."}), 409
            cursor.execute("""
                UPDATE movimientos_acceso
                SET fecha_entrada = ?, camara_entrada = ?, sync = 0, updated_at = ?, last_operator = ?
                WHERE id = ?
            """, (
                timestamp,
                clean_text(payload.get("camera")),
                timestamp,
                clean_text(payload.get("operator_name")),
                movement_id
            ))
        elif action == "update":
            if status == "Egresado":
                return jsonify({"ok": False, "error": "No se puede modificar un movimiento egresado."}), 409
            fields = {
                "placa": clean_text(payload.get("placa"), movement.get("placa")).upper(),
                "telefono": clean_text(payload.get("telefono"), movement.get("telefono")),
                "visitor_name": clean_text(payload.get("visitor_name"), movement.get("visitor_name")),
                "notes": clean_text(payload.get("notes"), movement.get("notes")),
                "movement_type": clean_text(payload.get("movement_type"), movement.get("movement_type") or "Visita"),
                "person_type": normalize_kind(payload.get("kind") or movement.get("person_type")),
                "vehicle_type": clean_text(payload.get("vehicle_type"), movement.get("vehicle_type")),
                "vehicle_category": clean_text(payload.get("vehicle_category"), movement.get("vehicle_category")),
                "economic_number": clean_text(payload.get("economic_number"), movement.get("economic_number")),
                "brand": clean_text(payload.get("brand"), movement.get("brand")),
                "model": clean_text(payload.get("model"), movement.get("model")),
                "vehicle_year": clean_text(payload.get("vehicle_year"), movement.get("vehicle_year")),
                "color": clean_text(payload.get("color"), movement.get("color")),
                "short_description": clean_text(payload.get("short_description"), movement.get("short_description")),
                "visit_to": clean_text(payload.get("visit_to"), movement.get("visit_to")),
                "area": clean_text(payload.get("area"), movement.get("area")),
                "contact": clean_text(payload.get("contact"), movement.get("contact")),
                "operator_name": clean_text(payload.get("operator_name"), movement.get("operator_name")),
                "last_operator": clean_text(payload.get("operator_name"), movement.get("last_operator")),
                "inspection_notes": clean_text(payload.get("inspection_notes"), movement.get("inspection_notes")),
                "updated_at": timestamp
            }
            if fields["person_type"] == "Vehiculo" and not fields["placa"]:
                return jsonify({"ok": False, "error": "Las placas son obligatorias para movimientos vehiculares."}), 400
            cursor.execute("""
                UPDATE movimientos_acceso
                SET placa = ?, telefono = ?, visitor_name = ?, notes = ?, movement_type = ?,
                    person_type = ?, vehicle_type = ?, vehicle_category = ?, economic_number = ?,
                    brand = ?, model = ?, vehicle_year = ?, color = ?, short_description = ?,
                    visit_to = ?, area = ?, contact = ?, operator_name = ?, last_operator = ?,
                    inspection_notes = ?, updated_at = ?
                WHERE id = ?
            """, (
                fields["placa"], fields["telefono"], fields["visitor_name"], fields["notes"],
                fields["movement_type"], fields["person_type"], fields["vehicle_type"],
                fields["vehicle_category"], fields["economic_number"], fields["brand"],
                fields["model"], fields["vehicle_year"], fields["color"], fields["short_description"],
                fields["visit_to"], fields["area"], fields["contact"], fields["operator_name"],
                fields["last_operator"], fields["inspection_notes"], fields["updated_at"], movement_id
            ))
        else:
            return jsonify({"ok": False, "error": "Accion de movimiento no soportada."}), 400

        conn.commit()
        updated = fetch_operator_movement(cursor, movement_id)
        return jsonify({"ok": True, "movement": updated})
    finally:
        conn.close()


@app.route("/api/hardware", methods=["GET", "PUT"])
def api_hardware():
    config = load_config()
    if request.method == "GET":
        return jsonify({"ok": True, **public_hardware_payload(config)})

    try:
        cameras, barriers = normalize_hardware_payload(request.get_json(silent=True) or {})
        config["cameras"] = cameras
        config["barriers"] = barriers
        save_config(config)
        generar_stream_config()
        return jsonify({"ok": True, **public_hardware_payload(config)})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/config", methods=["GET", "PUT"])
def api_config():
    config = load_config()
    if request.method == "GET":
        return jsonify({"ok": True, **public_config_payload(config)})

    try:
        apply_config_payload(config, request.get_json(silent=True) or {})
        save_config(config)
        return jsonify({"ok": True, **public_config_payload(config)})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/services/<service_id>/<action>", methods=["POST"])
def api_service_action(service_id, action):
    if action not in {"start", "stop", "restart"}:
        return jsonify({"error": "Accion no soportada"}), 400

    try:
        if service_id == "anpr-processor":
            if action in {"stop", "restart"}:
                stop_main_app()
            if action in {"start", "restart"}:
                restart_main_app()
        elif service_id == "rtsp-preview":
            if action in {"stop", "restart"}:
                stop_rtsp_to_mse()
            if action in {"start", "restart"}:
                generar_stream_config()
                ejecutar_rtsp_to_mse()
        elif service_id == "visit-sync":
            if action in {"stop", "restart"}:
                stop_background_worker()
            if action in {"start", "restart"}:
                start_background_worker()
        else:
            return jsonify({"error": f"Servicio '{service_id}' no encontrado"}), 404

        return jsonify({"ok": True, "services": service_status_payload()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/logs_stream")
# @requires_auth
def logs_stream():
    def event_stream():
        q = queue.Queue(maxsize=20)
        clients.append(q)
        # Enviar historial reciente
        for line in list(log_buffer):
             yield f"data: {line.strip()}\n\n"

        try:
            while True:
                try:
                    # Espera un log nuevo, pero no bloquea infinito
                    line = q.get(timeout=10)
                    yield f"data: {line.strip()}\n\n"
                except queue.Empty:
                    # Mantiene viva la conexión SSE
                    yield ": keep-alive\n\n"
        except GeneratorExit:
            # Cliente desconectado
            if q in clients:
                clients.remove(q)

    return Response(stream_with_context(event_stream()), mimetype="text/event-stream")

@app.route("/placas", methods=["GET", "POST"])
def view_plates():
    config = load_config()
    if request.method == "POST":
        id_acceso = request.form.get("id_acceso")
        id_estacionamiento = request.form.get("id_estacionamiento")

        if id_acceso is not None:
            config["id_acceso"] = id_acceso.strip()
        if id_estacionamiento is not None:
            config["id_estacionamiento"] = id_estacionamiento.strip()

        save_config(config)
        return redirect(url_for("view_plates"))

    page = request.args.get('page', 1, type=int)
    search = request.args.get('search', '').strip()
    per_page = 10
    offset = (page - 1) * per_page

    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()

        if search:
            search_param = f"%{search}%"
            c.execute("SELECT COUNT(*) FROM vehiculos WHERE placa LIKE ? OR nombre LIKE ?", (search_param, search_param))
            total_count = c.fetchone()[0]
            total_pages = (total_count + per_page - 1) // per_page

            c.execute("SELECT placa, nombre, telefono FROM vehiculos WHERE placa LIKE ? OR nombre LIKE ? ORDER BY placa LIMIT ? OFFSET ?",
                      (search_param, search_param, per_page, offset))
        else:
            c.execute("SELECT COUNT(*) FROM vehiculos")
            total_count = c.fetchone()[0]
            total_pages = (total_count + per_page - 1) // per_page

            c.execute("SELECT placa, nombre, telefono FROM vehiculos ORDER BY placa LIMIT ? OFFSET ?", (per_page, offset))

        placas_data = [{"placa": row[0], "nombre": row[1], "telefono": row[2]} for row in c.fetchall()]
        conn.close()

        app_running = app_process is not None and app_process.poll() is None
        return render_template(
            "placas.html",
            placas=placas_data,
            app_running=app_running,
            id_acceso=config.get("id_acceso", ""),
            id_estacionamiento=config.get("id_estacionamiento", ""),
            page=page,
            total_pages=total_pages,
            total_count=total_count,
            per_page=per_page,
            search=search
        )
    except Exception as e:
        return f"Error al cargar placas: {e}", 500

@app.route("/api/placas/<placa>", methods=["DELETE"])
def delete_plate(placa):
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("DELETE FROM vehiculos WHERE placa = ?", (placa,))
        conn.commit()
        conn.close()
        return jsonify({"message": "Placa eliminada"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/start", methods=["POST"])
# @requires_auth
def start_services():
    """Endpoint para iniciar los servicios"""
    restart_main_app()
    start_background_worker()
    ejecutar_rtsp_to_mse()
    return redirect(url_for("index"))

@app.route("/stop", methods=["POST"])
# @requires_auth
def stop_services():
    """Endpoint para detener los servicios"""
    stop_main_app()
    stop_rtsp_to_mse()
    stop_background_worker()
    return redirect(url_for("index"))

@app.route("/accesos", methods=["GET", "POST"])
def view_accesos():
    config = load_config()

    # Manejar guardado de id_acceso
    if request.method == "POST":
        id_acceso = request.form.get("id_acceso")
        if id_acceso is not None:
            config["id_acceso"] = id_acceso.strip()
            save_config(config)
        return redirect(url_for("view_accesos", tab="config"))

    # Paginación y búsqueda para placas
    page = request.args.get('page', 1, type=int)
    search = request.args.get('search', '').strip()
    active_tab = request.args.get('tab', 'movimientos')
    per_page = 10
    offset = (page - 1) * per_page

    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()

        # 1. Obtener placas
        if search:
            search_param = f"%{search}%"
            c.execute("SELECT COUNT(*) FROM vehiculos WHERE placa LIKE ? OR nombre LIKE ?", (search_param, search_param))
            total_count = c.fetchone()[0]
            total_pages = (total_count + per_page - 1) // per_page

            c.execute("SELECT placa, nombre, telefono FROM vehiculos WHERE placa LIKE ? OR nombre LIKE ? ORDER BY placa LIMIT ? OFFSET ?",
                      (search_param, search_param, per_page, offset))
        else:
            c.execute("SELECT COUNT(*) FROM vehiculos")
            total_count = c.fetchone()[0]
            total_pages = (total_count + per_page - 1) // per_page

            c.execute("SELECT placa, nombre, telefono FROM vehiculos ORDER BY placa LIMIT ? OFFSET ?", (per_page, offset))

        placas_data = [{"placa": row[0], "nombre": row[1], "telefono": row[2]} for row in c.fetchall()]

        # 2. Obtener movimientos de acceso
        c.execute("SELECT folio, placa, telefono, id_acceso, fecha_entrada, fecha_salida, camara_entrada, camara_salida, imagen, imagen_salida, sync, uid_bubble, prefijo FROM movimientos_acceso ORDER BY fecha_entrada DESC LIMIT 100")
        accesos = [
            {
                "folio": row[0],
                "placa": row[1],
                "telefono": row[2],
                "id_acceso": row[3],
                "fecha_entrada": row[4],
                "fecha_salida": row[5],
                "camara_entrada": row[6],
                "camara_salida": row[7],
                "imagen": row[8],
                "imagen_salida": row[9],
                "sync": row[10],
                "uid_bubble": row[11],
                "prefijo": row[12]
            } for row in c.fetchall()
        ]

        conn.close()

        app_running = app_process is not None and app_process.poll() is None
        return render_template(
            "accesos.html",
            accesos=accesos,
            placas=placas_data,
            app_running=app_running,
            id_acceso=config.get("id_acceso", ""),
            page=page,
            total_pages=total_pages,
            total_count=total_count,
            per_page=per_page,
            search=search,
            active_tab=active_tab
        )
    except Exception as e:
        return f"Error al cargar accesos: {e}", 500

@app.route("/restart", methods=["POST"])
# @requires_auth
def restart_services():
    """Endpoint para reiniciar los servicios"""
    stop_background_worker()
    restart_main_app()
    start_background_worker()
    ejecutar_rtsp_to_mse()
    return redirect(url_for("index"))

@app.route("/hardware", methods=["GET", "POST"])
# @requires_auth
def hardware():
    if request.method == "POST":
        data = load_config()
        cameras = []
        barriers = []

        # Recoger cámaras estáticas
        i = 1
        import random, string
        def gen_prefix():
            return ''.join(random.choices(string.ascii_uppercase, k=3))

        while True:
            name = request.form.get(f"name_{i}")
            rtsp = request.form.get(f"rtsp_{i}")
            c_type = request.form.get(f"type_{i}", "Entrada")
            c_prefix = request.form.get(f"prefix_{i}")
            if not name and not rtsp:
                break
            if name and rtsp:
                cameras.append({
                    "name": name.strip(),
                    "rtsp": rtsp.strip(),
                    "type": c_type,
                    "prefix": (c_prefix or gen_prefix()).strip().upper()[:3]
                })
            i += 1

        # Recoger cámaras dinámicas
        for key in request.form:
            if key.startswith("name_dynamic_"):
                idx = key.split("_")[-1]
                name = request.form.get(key)
                rtsp = request.form.get(f"rtsp_dynamic_{idx}")
                c_type = request.form.get(f"type_dynamic_{idx}", "Entrada")
                c_prefix = request.form.get(f"prefix_dynamic_{idx}")
                if name and rtsp:
                    cameras.append({
                        "name": name.strip(),
                        "rtsp": rtsp.strip(),
                        "type": c_type,
                        "prefix": (c_prefix or gen_prefix()).strip().upper()[:3]
                    })

        # Recoger barreras estáticas
        i = 1
        while True:
            b_id = request.form.get(f"b_id_{i}")
            b_num = request.form.get(f"b_num_{i}")
            b_ip = request.form.get(f"b_ip_{i}")
            b_user = request.form.get(f"b_user_{i}")
            b_pass = request.form.get(f"b_pass_{i}")
            b_cam = request.form.get(f"b_cam_{i}")
            if not b_id:
                break
            barriers.append({
                "id_barra": b_id.strip(),
                "numero_barra": b_num.strip(),
                "ip_puerto": b_ip.strip(),
                "usuario": b_user.strip() if b_user else "",
                "password": b_pass.strip() if b_pass else "",
                "camera_name": b_cam
            })
            i += 1

        # Recoger barreras dinámicas
        for key in request.form:
            if key.startswith("b_id_dynamic_"):
                idx = key.split("_")[-1]
                b_id = request.form.get(key)
                b_num = request.form.get(f"b_num_dynamic_{idx}")
                b_ip = request.form.get(f"b_ip_dynamic_{idx}")
                b_user = request.form.get(f"b_user_dynamic_{idx}")
                b_pass = request.form.get(f"b_pass_dynamic_{idx}")
                b_cam = request.form.get(f"b_cam_dynamic_{idx}")
                if b_id:
                    barriers.append({
                        "id_barra": b_id.strip(),
                        "numero_barra": b_num.strip(),
                        "ip_puerto": b_ip.strip(),
                        "usuario": b_user.strip() if b_user else "",
                        "password": b_pass.strip() if b_pass else "",
                        "camera_name": b_cam
                    })

        data["cameras"] = cameras
        data["barriers"] = barriers
        save_config(data)

        generar_stream_config()
        return redirect(url_for("hardware"))

    config = load_config()
    app_running = app_process is not None and app_process.poll() is None
    return render_template(
        "hardware.html",
        cameras=config.get("cameras", []),
        barriers=config.get("barriers", []),
        app_running=app_running
    )

@app.route("/", methods=["GET", "POST"])
# @requires_auth
def index():
    if request.method == "POST":
        data = load_config()
        server_url   = request.form.get("server_url")
        version      = request.form.get("version")
        bubble_token = request.form.get("bubble_token")

        min_plate_w  = request.form.get("min_plate_width_ratio")
        min_plate_h  = request.form.get("min_plate_height_ratio")
        require_veh  = request.form.get("require_vehicle_detection")
        strict_plate = request.form.get("strict_plate_validation")
        min_vconf    = request.form.get("min_vehicle_confidence")

        if server_url is not None:
            data["server_url"] = server_url.strip()
        if version in ("test", "live"):
            data["version"] = version
        if bubble_token is not None:
            data["bubble_token"] = bubble_token.strip()

        if min_plate_w is not None:
            try:
                data["min_plate_width_ratio"] = float(min_plate_w)
            except ValueError:
                pass
        if min_plate_h is not None:
            try:
                data["min_plate_height_ratio"] = float(min_plate_h)
            except ValueError:
                pass

        data["require_vehicle_detection"] = (require_veh == "on" or require_veh == "true")
        data["strict_plate_validation"] = (strict_plate == "on" or strict_plate == "true")

        if min_vconf is not None:
            try:
                data["min_vehicle_confidence"] = float(min_vconf)
            except ValueError:
                pass

        save_config(data)
        return redirect(url_for("index"))

    config = load_config()
    app_running = app_process is not None and app_process.poll() is None
    return render_template(
        "configuracion.html",
        server_url=config.get("server_url", ""),
        bubble_version=config.get("version", "test"),
        bubble_token=config.get("bubble_token", ""),
        min_plate_width_ratio=config.get("min_plate_width_ratio", 0.02),
        min_plate_height_ratio=config.get("min_plate_height_ratio", 0.02),
        strict_plate_validation=config.get("strict_plate_validation", True),
        require_vehicle_detection=config.get("require_vehicle_detection", False),
        min_vehicle_confidence=config.get("min_vehicle_confidence", 0.78),
        app_running=app_running
    )

def _shutdown_app_process():
    """Mata el proceso de app.py al salir de web_config.py"""
    print("[SHUTDOWN] Deteniendo servicios ANPR...")
    stop_background_worker()
    stop_rtsp_to_mse()
    stop_main_app()
    print("[SHUTDOWN] Servicios ANPR detenidos.")

def _signal_handler(signum, frame):
    """Captura señales de terminación para hacer un cierre limpio"""
    _shutdown_app_process()
    sys.exit(0)

if __name__ == "__main__":
    if "--anpr-worker" in sys.argv:
        from app import main as anpr_worker_main
        anpr_worker_main()
        sys.exit(0)

    # Registrar handler de salida para matar app.py cuando web_config.py termine
    atexit.register(_shutdown_app_process)
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    # Iniciar el worker de sincronización aquí (solo en ejecución directa, no con Gunicorn)
    start_background_worker()

    # Iniciar el servicio ANPR automáticamente al arrancar la aplicación
    print("[INICIO] Arrancando servicio ANPR automáticamente...")
    restart_main_app()

    app.run(host="0.0.0.0", port=ANPR_API_PORT, debug=False)
