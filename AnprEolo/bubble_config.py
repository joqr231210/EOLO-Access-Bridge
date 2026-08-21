# ============================================================
#  bubble_config.py  –  Constantes de la API de Bubble
#
#  Prioridad de configuración:
#    1. config.json  (campos: "version": "test"|"live",  "bubble_token": "...")
#    2. Variables de entorno  BUBBLE_BASE_URL / BUBBLE_TOKEN
#    3. Valores por defecto sin token (version-test)
# ============================================================
import os
import json

_CONFIG_FILE = "config.json"
_DEFAULT_TOKEN = ""
_BUBBLE_APP    = "https://parco.bubbleapps.io"


def _load_bubble_settings():
    """Lee version y bubble_token desde config.json si existe."""
    try:
        with open(_CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        version = cfg.get("version", "test")          # "test" o "live"
        token   = cfg.get("bubble_token", "").strip()
        return version, token
    except Exception:
        return "test", ""


def _build_urls():
    """Construye las URLs y cabeceras leyendo la config en tiempo de ejecución."""
    version, token = _load_bubble_settings()

    # Fallback: env var > config.json > default vacío
    version_segment = "version-live" if version == "live" else "version-test"
    base_url = os.environ.get(
        "BUBBLE_BASE_URL",
        f"{_BUBBLE_APP}/{version_segment}/api/1.1/wf"
    )
    token = os.environ.get("BUBBLE_TOKEN", token or _DEFAULT_TOKEN)

    headers = {"Authorization": f"Bearer {token}"}
    return base_url, token, headers


def _get(attr):
    """Accessor lazy para cada constante, re-lee config en cada llamada."""
    base_url, token, headers = _build_urls()
    mapping = {
        "BUBBLE_BASE_URL":                   base_url,
        "BUBBLE_TOKEN":                      token,
        "BUBBLE_HEADERS":                    headers,
        "URL_GET_PLACAS_RESIDENTES":         f"{base_url}/get_placas_residentes",
        "URL_GET_MOV_PREAUTORIZADOS":        f"{base_url}/acceso_mov_preautorizados",
        "URL_CREATE_ACCESO_MOV_RESIDENTE":   f"{base_url}/create-acceso-movimiento-residente",
        "URL_SALIDA_ACCESO":                 f"{base_url}/salida-acceso",
        "URL_ENTRADA_ACCESO_PREAUTORIZADO":  f"{base_url}/entrada_acceso_preautorizado",
        "URL_GET_EXENTOS_ESTACIONAMIENTO":   f"{base_url}/movimientos_cero",
        "URL_APK_SALIDA_RESERVA":            f"{base_url}/apk_salida_reserva",
        "URL_GET_PLACAS_INVENTARIO":         f"{base_url}/inventario_estacionamiento",
        "URL_APK_COBRAR":                    f"{base_url}/apk_cobrar",
    }
    return mapping[attr]


class _LazyModule:
    """Módulo proxy que recalcula las constantes en cada acceso."""
    def __getattr__(self, name):
        # Ignorar atributos especiales de Python / sistema de importación
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _get(name)


# Reemplazar el módulo actual por el proxy lazy
import sys as _sys
_sys.modules[__name__] = _LazyModule()
