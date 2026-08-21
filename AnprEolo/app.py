import cv2
import time
import requests
import base64
import numpy as np
import argparse
import os
import threading
from ultralytics import YOLO
import re
from fast_plate_ocr import LicensePlateRecognizer
import os, sys
import json, sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RESOURCE_DIR = getattr(sys, "_MEIPASS", BASE_DIR)
DB_FILE = os.environ.get("ANPR_DB_FILE", os.path.join(BASE_DIR, "plates.db"))
CONFIG_FILE = os.environ.get("ANPR_CONFIG_FILE", os.path.join(BASE_DIR, "config.json"))
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
CONTROL_BASE_URL = os.environ.get("ANPR_CONTROL_BASE_URL", "http://127.0.0.1:8090").rstrip("/")
DEMO_BARRIER = {
    "id_barra": "demo-barrier",
    "numero_barra": "1",
    "ip_puerto": "192.168.1.10:80",
    "usuario": "admin",
    "password": "",
    "camera_name": "",
}

if getattr(sys, 'frozen', False):
    # Añadir el directorio donde está el exe y las DLL
    exe_dir = os.path.dirname(sys.executable)
    os.environ["PATH"] = exe_dir + os.pathsep + os.environ["PATH"]

    # En Python 3.8+, también puedes usar:
    try:
        os.add_dll_directory(exe_dir)
    except (AttributeError, FileNotFoundError):
        pass

def resource_path(file_name):
    return os.environ.get(
        f"ANPR_{file_name.upper().replace('.', '_')}",
        os.path.join(RESOURCE_DIR, file_name)
    )

# --- CONFIGURACIÓN GENERAL ---
FPS_PROCESAR = 15
CACHE_TIEMPO_SEGUNDOS = 25
YOLO_MODEL_PATH = os.environ.get("ANPR_PLATE_MODEL_FILE", resource_path("model.pt"))
YOLO_MODEL_VEHICLE_PATH = os.environ.get("ANPR_VEHICLE_MODEL_FILE", resource_path("best.pt"))

# --- Cargar configuración ---
def load_config():
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
        if "barriers" not in data:
            data["barriers"] = [dict(DEMO_BARRIER)]
        return data

CLASSES_VEHICULOS = ['Car', 'Motorcycle', 'Truck', 'Bus', 'Bicycle']
PLATE_TEXT_PATTERN = re.compile(r'^[A-Z0-9]{4,12}$')
STRICT_PLATE_TEXT_PATTERN = re.compile(r'(?=(?:.*[A-Z]){2,})(?=(?:.*\d){3,})[A-Z0-9]+')

# --- VARIABLES GLOBALES POR CÁMARA ---
shared_frames = {}
lock = threading.Lock()
detections_lock = threading.Lock()
latest_detections = {}
status_lock = threading.Lock()
anpr_status = {}
stop_flag = threading.Event()  # Flag para detener threads

# --- FUNCIONES ---
def utc_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def escribir_json_atomico(file_path, payload):
    tmp_path = f"{file_path}.tmp"
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp_path, file_path)

def camera_snapshot_name(camera_name):
    safe_name = re.sub(r'[^A-Za-z0-9_.-]+', '_', str(camera_name or '').strip())
    return safe_name or "camera"

def guardar_snapshot_camara(camera_name, frame):
    if frame is None:
        return ""
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    file_path = os.path.join(SNAPSHOT_DIR, f"{camera_snapshot_name(camera_name)}.jpg")
    tmp_path = f"{file_path}.tmp.jpg"
    ok = cv2.imwrite(tmp_path, frame)
    if not ok:
        return ""
    os.replace(tmp_path, file_path)
    return file_path

def publicar_estado_anpr(camera_name, **fields):
    with status_lock:
        current = anpr_status.get(camera_name, {})
        current.update(fields)
        current["camera"] = camera_name
        current["updated_at"] = utc_iso()
        anpr_status[camera_name] = current
        escribir_json_atomico(STATUS_FILE, {
            "updated_at": current["updated_at"],
            "cameras": anpr_status,
        })

def publicar_lectura_anpr(camera_name, placa, clase="Desconocido", confidence=0.0):
    now = time.time()
    event = {
        "camera": camera_name,
        "plate": placa,
        "vehicle_class": clase,
        "confidence": round(float(confidence or 0.0), 4),
        "detected_at": utc_iso(),
        "detected_at_ms": int(now * 1000),
        "snapshot_url": f"/api/anpr/snapshots/{camera_snapshot_name(camera_name)}",
    }
    with detections_lock:
        latest_detections[camera_name] = event
        payload = {
            "updated_at": event["detected_at"],
            "detections": latest_detections,
        }
        escribir_json_atomico(DETECTIONS_FILE, payload)

def limpiar_cache(cache):
    ahora = time.time()
    expiradas = [p for p, t in cache.items() if ahora - t > CACHE_TIEMPO_SEGUNDOS]
    for p in expiradas:
        del cache[p]

def recortar_bbox(img, bbox):
    x1, y1, x2, y2 = map(int, bbox)
    return img[y1:y2, x1:x2]

def placa_valida(texto_detectado, config):
    texto = str(texto_detectado or "").strip().upper()
    if not PLATE_TEXT_PATTERN.fullmatch(texto):
        return False
    if config.get("strict_plate_validation", True):
        return bool(STRICT_PLATE_TEXT_PATTERN.fullmatch(texto))
    return True

def enviar_datos(img, texto, camera_name, clase):
    _, buffer = cv2.imencode('.jpg', img)
    base64_img = base64.b64encode(buffer).decode('utf-8')
    data = {
        "plate": texto,
        "camera-id": camera_name,
        "clase": clase,
        "image": base64_img,
    }
    try:
        r = requests.post(SERVER_URL, json=data)
        print(f"[{time.strftime('%H:%M:%S')}] [{camera_name}] Enviado: {texto} ({r.status_code})")
    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] [{camera_name}] ERROR al enviar: {e}")

def control_post(path, timeout=1):
    """Llama al API de control local sin acoplar el procesador a un puerto fijo."""
    try:
        return requests.post(f"{CONTROL_BASE_URL}{path}", timeout=timeout)
    except Exception:
        return None

def verificar_placa(placa):
    """Verifica si la placa está en la base de datos de residentes"""
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("SELECT 1 FROM vehiculos WHERE placa = ?", (placa.strip().upper(),))
        existe = c.fetchone() is not None
        conn.close()
        return existe
    except Exception as e:
        print(f"[ERROR DB] {e}")
        return False

def verificar_preautorizado(placa):
    """Verifica si la placa tiene un movimiento preautorizado activo. Devuelve (id_local, uid_movimiento) o (None, None)"""
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute(
            "SELECT id, uid_movimiento FROM movimientos_preautorizados WHERE placa = ? AND estatus = 'Preautorizado'",
            (placa.strip().upper(),)
        )
        row = c.fetchone()
        conn.close()
        if row:
            return row[0], row[1]
        return None, None
    except Exception as e:
        print(f"[ERROR DB PREAUT] {e}")
        return None, None

def registrar_ingreso_preautorizado(placa, camera_name, frame, pid, uid_movimiento):
    """Registra el ingreso de un vehículo preautorizado y encola el POST a Bubble"""
    try:
        ahora = time.strftime('%Y-%m-%d %H:%M:%S')

        # Guardar imagen localmente
        save_dir = os.path.join("static", "captures")
        if not os.path.exists(save_dir):
            os.makedirs(save_dir)
        img_filename = f"preaut_{uid_movimiento}_{placa}_in.jpg"
        img_path = os.path.join(save_dir, img_filename)
        cv2.imwrite(img_path, frame)
        relative_path = f"captures/{img_filename}"

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("""
            UPDATE movimientos_preautorizados
            SET estatus = 'Ingresado', fecha_ingreso = ?, imagen_ingreso = ?, camara_ingreso = ?, sync = 0
            WHERE id = ?
        """, (ahora, relative_path, camera_name, pid))
        conn.commit()
        conn.close()

        print(f"[PREAUT] Ingreso registrado: {placa} | Mov {uid_movimiento} ({camera_name})")

        # Intentar sync inmediato
        threading.Thread(target=lambda: control_post("/api/sync_now"), daemon=True).start()

    except Exception as e:
        print(f"[ERROR REGISTRO PREAUT] {e}")

def verificar_exento_estacionamiento(placa):
    """Verifica si la placa tiene un exento de estacionamiento activo. Devuelve (id_local, id_movimiento) o (None, None)"""
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute(
            "SELECT id, id_movimiento FROM exentos_estacionamiento WHERE placa = ? AND estatus = 'Pendiente'",
            (placa.strip().upper(),)
        )
        row = c.fetchone()
        conn.close()
        if row:
            return row[0], row[1]
        return None, None
    except Exception as e:
        print(f"[ERROR DB EXENTO] {e}")
        return None, None

def registrar_salida_exento(placa, camera_name, frame, eid, id_movimiento):
    """Registra la salida de un exento de estacionamiento y encola el POST a Bubble"""
    try:
        ahora = time.strftime('%Y-%m-%d %H:%M:%S')

        # Guardar imagen localmente
        save_dir = os.path.join("static", "captures")
        if not os.path.exists(save_dir):
            os.makedirs(save_dir)
        img_filename = f"exento_{id_movimiento}_{placa}_out.jpg"
        img_path = os.path.join(save_dir, img_filename)
        cv2.imwrite(img_path, frame)
        relative_path = f"captures/{img_filename}"

        config = load_config()
        id_estacionamiento = config.get("id_estacionamiento", "")

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()

        # Crear movimiento de estacionamiento (salida, sync=0 para enviar a Bubble)
        c.execute("""
            INSERT INTO movimientos_estacionamiento
            (placa, id_estacionamiento, id_movimiento_reserva, fecha_salida, camara_salida, imagen_salida, sync)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        """, (placa, id_estacionamiento, id_movimiento, ahora, camera_name, relative_path))

        # Marcar exento como usado
        c.execute(
            "UPDATE exentos_estacionamiento SET estatus = 'Usado' WHERE id = ?",
            (eid,)
        )

        conn.commit()
        conn.close()

        print(f"[EXENTO] Salida registrada: {placa} | Reserva {id_movimiento} ({camera_name})")

        # Intentar sync inmediato
        threading.Thread(target=lambda: control_post("/api/sync_now"), daemon=True).start()

    except Exception as e:
        print(f"[ERROR REGISTRO EXENTO] {e}")

def verificar_inventario_estacionamiento(placa):
    """Verifica si la placa está en inventario y tiene balance suficiente. Devuelve datos o None"""
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute(
            "SELECT id, uid_reserva, id_wallet, balance_wallet, total_por_pagar, por_pagar_reserva, por_pagar_servicio FROM inventario_estacionamiento WHERE placa = ?",
            (placa,)
        )
        row = c.fetchone()
        print(f"Datos de inventario: {row}")
        conn.close()
        if row and row[3] >= row[4]: # balance_wallet >= total_por_pagar
            print(f"[INVENTARIO] {placa} tiene saldo suficiente")
            return row
        return None
    except Exception as e:
        print(f"[ERROR DB INVENTARIO] {e}")
        return None

def registrar_cobro_inventario(placa, camera_name, frame, inv_id, uid_reserva, id_wallet, balance_wallet, total_por_pagar, por_pagar_reserva):
    """Registra un cobro de inventario para enviar a Bubble y lo elimina de la tabla local"""
    try:
        # Guardar imagen localmente
        save_dir = os.path.join("static", "captures")
        if not os.path.exists(save_dir):
            os.makedirs(save_dir)
        img_filename = f"cobro_{uid_reserva}_{placa}_out.jpg"
        img_path = os.path.join(save_dir, img_filename)
        cv2.imwrite(img_path, frame)

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()

        # Insertar en tabla cobros_inventario
        c.execute("""
            INSERT INTO cobros_inventario
            (uid_reserva, placa, id_wallet, monto_saldo, monto_reserva, monto_total, sync)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        """, (uid_reserva, placa, id_wallet, total_por_pagar, por_pagar_reserva, total_por_pagar))

        # Eliminar el registro del inventario local (ya fue cobrado/procesado)
        c.execute("DELETE FROM inventario_estacionamiento WHERE id = ?", (inv_id,))

        conn.commit()
        conn.close()

        print(f"[COBRO INVENTARIO] Salida registrada y cobro en cola: {placa} | Reserva {uid_reserva} ({camera_name})")

        # Intentar sync inmediato
        threading.Thread(target=lambda: control_post("/api/sync_now"), daemon=True).start()

    except Exception as e:
        print(f"[ERROR REGISTRO COBRO] {e}")

def registrar_movimiento(placa, camera_name, frame):
    """Registra el movimiento de acceso (entrada o salida) según el tipo de cámara"""
    try:
        config = load_config()
        camera = next((c for c in config.get("cameras", []) if c["name"] == camera_name), None)

        if not camera:
            return

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        ahora = time.strftime('%Y-%m-%d %H:%M:%S')

        if camera.get("type") == "Entrada":
            # --- LÓGICA DE ENTRADA ---
            # 1. Verificar si ya hay una entrada activa (sin salida) para esta placa
            c.execute("SELECT 1 FROM movimientos_acceso WHERE placa = ? AND fecha_salida IS NULL", (placa,))
            if c.fetchone():
                conn.close()
                return # Ya está adentro, no registrar nueva entrada

            # 2. Obtener el siguiente folio
            c.execute("SELECT MAX(folio) FROM movimientos_acceso")
            max_folio = c.fetchone()[0]
            nuevo_folio = (max_folio or 0) + 1
            prefix = camera.get("prefix", "CAM")

            # 3. Obtener datos del residente (teléfono)
            c.execute("SELECT telefono FROM vehiculos WHERE placa = ?", (placa,))
            res = c.fetchone()
            telefono = res[0] if res else ""

            # 4. Guardar imagen localmente
            img_filename = f"folio_{prefix}_{nuevo_folio}_{placa}_in.jpg"
            save_dir = os.path.join("static", "captures")
            if not os.path.exists(save_dir):
                os.makedirs(save_dir)

            img_path = os.path.join(save_dir, img_filename)
            cv2.imwrite(img_path, frame)
            relative_path = f"captures/{img_filename}"

            # 5. Insertar movimiento
            id_acceso = config.get("id_acceso", "")

            c.execute("""
                INSERT INTO movimientos_acceso (folio, placa, telefono, id_acceso, fecha_entrada, camara_entrada, imagen, prefijo)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (nuevo_folio, placa, telefono, id_acceso, ahora, camera_name, relative_path, prefix))

            print(f"[MOVIMIENTO] Entrada registrada: Folio {prefix}-{nuevo_folio}, Placa {placa} ({camera_name})")

        elif camera.get("type") == "Salida":
            # --- LÓGICA DE SALIDA ---
            # 1. Buscar la entrada activa para esta placa
            c.execute("SELECT id, folio FROM movimientos_acceso WHERE placa = ? AND fecha_salida IS NULL ORDER BY fecha_entrada DESC", (placa,))
            mov = c.fetchone()

            if mov:
                mov_id = mov[0]
                folio = mov[1]

                # 2. Guardar imagen de salida localmente
                img_filename = f"folio_{folio}_{placa}_out.jpg"
                save_dir = os.path.join("static", "captures")
                if not os.path.exists(save_dir):
                    os.makedirs(save_dir)

                img_path = os.path.join(save_dir, img_filename)
                cv2.imwrite(img_path, frame)
                relative_path_out = f"captures/{img_filename}"

                # 3. Actualizar registro con fecha, cámara e imagen de salida
                # Ponemos sync = 0 para que el worker lo vuelva a subir a Bubble con la fecha de salida
                c.execute("""
                    UPDATE movimientos_acceso
                    SET fecha_salida = ?, camara_salida = ?, imagen_salida = ?, sync = 0
                    WHERE id = ?
                """, (ahora, camera_name, relative_path_out, mov_id))

                print(f"[MOVIMIENTO] Salida registrada: Folio {folio}, Placa {placa} ({camera_name}). Imagen de salida guardada.")
            else:
                print(f"[MOVIMIENTO] Salida detectada para {placa} pero no hay entrada activa registrada.")

        conn.commit()
        conn.close()

        # --- INTENTAR SYNC INMEDIATO ---
        threading.Thread(target=lambda: control_post("/api/sync_now"), daemon=True).start()

    except Exception as e:
        print(f"[ERROR REGISTRO MOV] {e}")

def abrir_barreras(camera_name):
    """Llama al endpoint de apertura de las barreras vinculadas a una cámara específica"""
    try:
        config = load_config()
        camera = next((c for c in config.get("cameras", []) if c.get("name") == camera_name), None)
        linked_ids = set(camera.get("barrier_ids", [])) if camera else set()
        barriers = config.get("barriers", [])
        for b in barriers:
            # Abrir si la camara la tiene asociada o si existe la relacion legacy en la barrera.
            linked_by_camera = b.get("id_barra") in linked_ids
            linked_by_legacy_barrier = b.get("camera_name") == camera_name
            if linked_by_camera or linked_by_legacy_barrier:
                id_barra = b.get("id_barra")
                if id_barra:
                    # El endpoint /open ahora es POST según el cambio del usuario
                    control_post(f"/open/{id_barra}", timeout=2)
                    print(f"[AUTO] Comando de apertura enviado a: {id_barra} (vinculada a {camera_name})")
    except Exception as e:
        print(f"[ERROR AUTO OPEN] {e}")

def capturar_frames(rtsp_url, camera_name, stop_flag):
    print(f"[{camera_name}] Iniciando captura...")
    publicar_estado_anpr(camera_name, capture_running=False, frame_count=0, last_error="")
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|buffer_size;102400"
    cap = cv2.VideoCapture(rtsp_url)

    if not cap.isOpened():
        print(f"[{camera_name}] ERROR: No se pudo abrir el stream.")
        publicar_estado_anpr(camera_name, capture_running=False, last_error="No se pudo abrir el stream RTSP.")
        return

    frame_count = 0
    last_status = 0
    last_snapshot = 0
    try:
        while not stop_flag.is_set():
            cap.grab()  # Solo avanza el buffer sin decodificar
            ret, frame = cap.retrieve()  # Decodifica el frame más reciente

            if not ret or frame is None:
                print(f"[{camera_name}] ERROR en captura, reconectando...")
                publicar_estado_anpr(camera_name, capture_running=False, last_error="Error de captura, reconectando.")
                time.sleep(2)
                cap.release()
                cap = cv2.VideoCapture(rtsp_url)
                continue

            with lock:
                shared_frames[camera_name] = frame
            frame_count += 1
            now = time.time()
            if now - last_snapshot >= 1:
                guardar_snapshot_camara(camera_name, frame)
                last_snapshot = now
            if now - last_status >= 2:
                frame_h, frame_w = frame.shape[:2]
                publicar_estado_anpr(
                    camera_name,
                    capture_running=True,
                    frame_count=frame_count,
                    frame_width=int(frame_w),
                    frame_height=int(frame_h),
                    last_frame_at=utc_iso(),
                    last_error=""
                )
                last_status = now
    finally:
        cap.release()
        publicar_estado_anpr(camera_name, capture_running=False)
        print(f"[{camera_name}] Captura detenida.")

def procesar_frames(camera_name, stop_flag):
    print(f"[{camera_name}] Iniciando procesamiento...")
    publicar_estado_anpr(camera_name, processing_running=False, models_loaded=False, last_error="")

    try:
        placa_model = YOLO(YOLO_MODEL_PATH)
        vehiculo_model = YOLO(YOLO_MODEL_VEHICLE_PATH)
        ocr_model = LicensePlateRecognizer('cct-s-v2-global-model')
        publicar_estado_anpr(camera_name, processing_running=True, models_loaded=True, last_error="")
    except Exception as e:
        print(f"[{camera_name}] ERROR al cargar modelos: {e}")
        publicar_estado_anpr(camera_name, processing_running=False, models_loaded=False, last_error=f"Error al cargar modelos: {e}")
        return

    cache = {}

    intervalo = 1.0 / FPS_PROCESAR
    last_time = time.time()
    last_cleanup = time.time()
    last_status = 0
    prediction_count = 0
    plate_candidate_count = 0
    ocr_attempt_count = 0
    valid_read_count = 0
    invalid_read_count = 0

    try:
        while not stop_flag.is_set():
            ahora = time.time()
            if ahora - last_time < intervalo:
                time.sleep(0.01)
                continue

            with lock:
                frame = shared_frames.get(camera_name)

            if frame is None:
                continue

            try:
                # 1. Detectar placas en el frame completo
                placa_results = placa_model.predict(frame, verbose=False)
                prediction_count += 1
                frame_candidate_count = 0

                for placa_result in placa_results:
                    placa_boxes = placa_result.boxes.xyxy.cpu().numpy()
                    frame_candidate_count += len(placa_boxes)

                    for pbox in placa_boxes:
                        x1, y1, x2, y2 = map(int, pbox)

                        # Filtrar por tamaño mínimo de la placa respecto al frame completo
                        frame_h, frame_w = frame.shape[:2]
                        plate_w = x2 - x1
                        plate_h = y2 - y1

                        config = load_config()
                        min_w_ratio = config.get("min_plate_width_ratio", 0.02)
                        min_h_ratio = config.get("min_plate_height_ratio", 0.02)

                        if plate_w < (frame_w * min_w_ratio) or plate_h < (frame_h * min_h_ratio):
                            continue

                        placa_img = frame[y1:y2, x1:x2]
                        processed_img = cv2.resize(placa_img, (128, 64))
                        processed_img = cv2.cvtColor(processed_img, cv2.COLOR_BGR2RGB)

                        ocr_attempt_count += 1
                        resultado = ocr_model.run([processed_img])[0]
                        # resultado = ["ABC123"]  # Simulación de OCR que coincide con el regex
                        if resultado:
                            texto_detectado = resultado.plate.replace("_", "").strip().upper()
                            if placa_valida(texto_detectado, config):
                                valid_read_count += 1
                                if texto_detectado not in cache:
                                    cache[texto_detectado] = ahora
                                    #print(f"[{camera_name}] Placa detectada: {texto_detectado}")

                                    # --- APERTURA AUTOMÁTICA ---
                                    if verificar_placa(texto_detectado):
                                        print(f"[{camera_name}] !!! RESIDENTE DETECTADO: {texto_detectado} !!!")
                                        registrar_movimiento(texto_detectado, camera_name, frame)
                                        threading.Thread(target=abrir_barreras, args=(camera_name,), daemon=True).start()
                                    else:
                                        pid, uid_mov = verificar_preautorizado(texto_detectado)
                                        if pid is not None:
                                            print(f"[{camera_name}] !!! PREAUTORIZADO DETECTADO: {texto_detectado} | Mov {uid_mov} !!!")
                                            registrar_ingreso_preautorizado(texto_detectado, camera_name, frame, pid, uid_mov)
                                            threading.Thread(target=abrir_barreras, args=(camera_name,), daemon=True).start()
                                        else:
                                            # Solo en cámaras de SALIDA: verificar exento de estacionamiento
                                            _cfg = load_config()
                                            _cam = next((cam for cam in _cfg.get("cameras", []) if cam["name"] == camera_name), None)
                                            if _cam and _cam.get("type") == "Salida":
                                                eid, id_mov_reserva = verificar_exento_estacionamiento(texto_detectado)
                                                if eid is not None:
                                                    print(f"[{camera_name}] !!! EXENTO ESTACIONAMIENTO: {texto_detectado} | Reserva {id_mov_reserva} !!!")
                                                    registrar_salida_exento(texto_detectado, camera_name, frame, eid, id_mov_reserva)
                                                    threading.Thread(target=abrir_barreras, args=(camera_name,), daemon=True).start()
                                                else:
                                                    inv_data = verificar_inventario_estacionamiento(texto_detectado)
                                                    if inv_data:
                                                        inv_id, uid_res, id_wallet, b_wallet, t_pagar, p_reserva, p_servicio = inv_data
                                                        print(f"[{camera_name}] !!! COBRO INVENTARIO: {texto_detectado} | Reserva {uid_res} !!!")
                                                        registrar_cobro_inventario(texto_detectado, camera_name, frame, inv_id, uid_res, id_wallet, b_wallet, t_pagar, p_reserva)
                                                        threading.Thread(target=abrir_barreras, args=(camera_name,), daemon=True).start()
                                     # ---------------------------

                                    # 2. Buscar tipo de vehículo (que contenga la placa)
                                    vehiculo_results = vehiculo_model.predict(frame, verbose=False)

                                    clase = "Desconocido"
                                    vconf_val = 0.0
                                    imagen_vehiculo = None

                                    config = load_config()
                                    min_vconf = config.get("min_vehicle_confidence", 0.78)

                                    px_center = (x1 + x2) / 2
                                    py_center = (y1 + y2) / 2

                                    for veh_result in vehiculo_results:
                                        veh_classes = veh_result.boxes.cls.cpu().numpy()
                                        veh_confs = veh_result.boxes.conf.cpu().numpy()
                                        veh_boxes = veh_result.boxes.xyxy.cpu().numpy()

                                        for cls_id, vconf, vbox in zip(veh_classes, veh_confs, veh_boxes):
                                            vx1, vy1, vx2, vy2 = vbox
                                            if vconf >= min_vconf and (vx1 <= px_center <= vx2) and (vy1 <= py_center <= vy2):
                                                clase = CLASSES_VEHICULOS[int(cls_id)]
                                                vconf_val = vconf
                                                imagen_vehiculo = recortar_bbox(frame, vbox)
                                                break  # Solo tomar el primer vehículo válido que contenga la placa

                                        if clase != "Desconocido":
                                            break

                                    print(f"[{camera_name}] {clase} detectado con placas {texto_detectado}: {clase} (conf: {vconf_val:.2f})")
                                    publicar_lectura_anpr(camera_name, texto_detectado, clase, vconf_val)
                                    publicar_estado_anpr(
                                        camera_name,
                                        last_plate=texto_detectado,
                                        last_plate_at=utc_iso(),
                                        last_vehicle_class=clase,
                                        last_vehicle_confidence=round(float(vconf_val or 0.0), 4),
                                        valid_read_count=valid_read_count,
                                        invalid_read_count=invalid_read_count,
                                        plate_candidate_count=plate_candidate_count,
                                        ocr_attempt_count=ocr_attempt_count,
                                        prediction_count=prediction_count,
                                        last_error=""
                                    )

                                    require_veh = config.get("require_vehicle_detection", False)
                                    if require_veh and clase == "Desconocido":
                                        print(f"[{camera_name}] Envío omitido: require_vehicle_detection está activo y no se detectó vehículo para la placa {texto_detectado}")
                                    else:
                                        imagen_a_enviar = imagen_vehiculo if imagen_vehiculo is not None else frame
                                        enviar_datos(imagen_a_enviar, texto_detectado, camera_name, clase)
                            else:
                                invalid_read_count += 1
                                publicar_estado_anpr(
                                    camera_name,
                                    last_ocr_text=texto_detectado,
                                    last_rejected_ocr_at=utc_iso(),
                                    invalid_read_count=invalid_read_count,
                                    ocr_attempt_count=ocr_attempt_count,
                                    plate_candidate_count=plate_candidate_count,
                                    prediction_count=prediction_count,
                                    last_error=""
                                )

                plate_candidate_count += frame_candidate_count
                if ahora - last_status >= 2:
                    publicar_estado_anpr(
                        camera_name,
                        processing_running=True,
                        prediction_count=prediction_count,
                        plate_candidate_count=plate_candidate_count,
                        ocr_attempt_count=ocr_attempt_count,
                        valid_read_count=valid_read_count,
                        invalid_read_count=invalid_read_count,
                        last_prediction_at=utc_iso(),
                        last_frame_candidates=int(frame_candidate_count),
                        last_error=""
                    )
                    last_status = ahora

            except Exception as e:
                print(f"[{camera_name}] Error en predicción: {e}")
                publicar_estado_anpr(camera_name, last_error=f"Error en predicción: {e}")

            if ahora - last_cleanup > 10:
                limpiar_cache(cache)
                last_cleanup = ahora

            last_time = ahora
    finally:
        publicar_estado_anpr(camera_name, processing_running=False)
        print(f"[{camera_name}] Procesamiento detenido.")

# --- INICIO PRINCIPAL ---
def main():
    global SERVER_URL
    config = load_config()
    SERVER_URL = config.get("server_url")
    CAMERAS = config.get("cameras", [])

    if not SERVER_URL or not CAMERAS:
        raise ValueError("Debes definir server_url y al menos una cámara en config.json")

    RTSP_LIST = [c["rtsp"] for c in CAMERAS]
    NAME_LIST = [c["name"] for c in CAMERAS]

    print(f"[INFO] Procesando {len(RTSP_LIST)} cámaras...")
    threads = []

    try:
        for rtsp_url, camera_name in zip(RTSP_LIST, NAME_LIST):
            rtsp_url = rtsp_url.strip()
            camera_name = camera_name.strip()
            t1 = threading.Thread(target=capturar_frames, args=(rtsp_url, camera_name, stop_flag))
            t2 = threading.Thread(target=procesar_frames, args=(camera_name, stop_flag))
            t1.start()
            t2.start()
            threads.extend([t1, t2])

        # Esperar a que se complete o se interrumpa
        try:
            for t in threads:
                t.join()
        except KeyboardInterrupt:
            print("\n[INFO] Deteniendo aplicación...")
            stop_flag.set()

    except Exception as e:
        print(f"[ERROR] Error en main: {e}")
        stop_flag.set()
    finally:
        # Esperar a que todos los threads terminen
        for t in threads:
            if t.is_alive():
                t.join(timeout=5)
        print("[INFO] Aplicación terminada.")

if __name__ == "__main__":
    main()
