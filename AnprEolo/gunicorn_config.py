"""
Configuración de Gunicorn para producción.
Inicia el hilo background_worker una sola vez por worker de Gunicorn.
"""
import os

bind = f"0.0.0.0:{os.environ.get('ANPR_API_PORT', os.environ.get('PORT', '8090'))}"
workers = 1       # 1 worker para mantener un solo proceso con acceso a SQLite
threads = 4       # 4 hilos por worker para concurrencia I/O
timeout = 120
worker_class = "gthread"


def post_fork(server, worker):
    """Hook ejecutado en el proceso hijo (worker) justo después del fork."""
    from web_config import start_background_worker, restart_main_app
    start_background_worker()
    server.log.info(f"[GUNICORN] background_worker iniciado en worker PID {worker.pid}")

    # Iniciar el servicio ANPR automáticamente
    server.log.info("[GUNICORN] Arrancando servicio ANPR automáticamente...")
    restart_main_app()
