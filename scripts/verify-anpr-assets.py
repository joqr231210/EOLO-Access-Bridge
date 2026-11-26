#!/usr/bin/env python3
"""Check the bundled ANPR models before building a desktop sidecar."""

import hashlib
import pathlib
import urllib.request
from unittest.mock import patch

from fast_plate_ocr import LicensePlateRecognizer
from ultralytics import YOLO


ANPR_DIR = pathlib.Path(__file__).resolve().parent.parent / "AnprEolo"
ASSETS = {
    "cct_s_v2_global.onnx": "384bbbd2cea3ef54761d3df70822ef3a349ee1a112aeafddbe0e3ba06bc6e47b",
    "cct_s_v2_global_plate_config.yaml": "0335c74a305173bb6f393efed0fde03cadeaa0b649ed8e19f431016d8232d0a6",
}


def main():
    for filename, expected_sha256 in ASSETS.items():
        file_path = ANPR_DIR / filename
        asset_bytes = file_path.read_bytes()
        # Git may check text YAML files out with CRLF on Windows while the
        # expected digest is recorded from the LF source artifact.
        if file_path.suffix.lower() in {".yaml", ".yml"}:
            asset_bytes = asset_bytes.replace(b"\r\n", b"\n")
        actual_sha256 = hashlib.sha256(asset_bytes).hexdigest()
        if actual_sha256 != expected_sha256:
            raise ValueError(f"El modelo ANPR {filename} no coincide con el SHA-256 esperado")

    YOLO(str(ANPR_DIR / "model.pt"))
    YOLO(str(ANPR_DIR / "best.pt"))
    with patch.object(urllib.request, "urlopen", side_effect=AssertionError("Acceso a red durante carga OCR")):
        LicensePlateRecognizer(
            onnx_model_path=ANPR_DIR / "cct_s_v2_global.onnx",
            plate_config_path=ANPR_DIR / "cct_s_v2_global_plate_config.yaml",
        )
    print("Modelos ANPR verificados y OCR cargado sin red")


if __name__ == "__main__":
    main()
