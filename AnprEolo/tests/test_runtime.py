import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import app as anpr


class AnprRuntimeTests(unittest.TestCase):
    def test_estado_reintenta_reemplazo_bloqueado(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = os.path.join(directory, "anpr-status.json")
            real_replace = os.replace
            attempts = []

            def replace_with_temporary_lock(source, target):
                attempts.append(source)
                if len(attempts) < 3:
                    raise PermissionError("Archivo en uso")
                return real_replace(source, target)

            with patch.object(anpr.os, "replace", side_effect=replace_with_temporary_lock), patch.object(
                anpr.time, "sleep"
            ):
                anpr.escribir_json_atomico(destination, {"ok": True})

            with open(destination, encoding="utf-8") as file:
                self.assertEqual(json.load(file), {"ok": True})
            self.assertEqual(len(attempts), 3)
            self.assertEqual(os.listdir(directory), ["anpr-status.json"])

    def test_captura_no_borra_error_de_modelos(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(anpr, "STATUS_FILE", os.path.join(directory, "anpr-status.json")):
                anpr.anpr_status.clear()
                anpr.last_status_file_error = None
                anpr.publicar_estado_anpr(
                    "Entrada", processing_running=False,
                    model_load_stage="fallo", processing_error="Error al cargar modelos: certificado"
                )
                anpr.publicar_estado_anpr("Entrada", capture_running=True, capture_error="")
                self.assertEqual(
                    anpr.anpr_status["Entrada"]["last_error"],
                    "Error al cargar modelos: certificado",
                )
                anpr.publicar_estado_anpr("Entrada", processing_running=True, processing_error="")
                self.assertEqual(anpr.anpr_status["Entrada"]["last_error"], "")
                anpr.anpr_status.clear()


if __name__ == "__main__":
    unittest.main()
