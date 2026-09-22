import os
import sys
import unittest
from contextlib import ExitStack
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import web_config as anpr


class AnprWatchdogTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(anpr, "anpr_processor_expected_running", True))
        self.stack.enter_context(mock.patch.object(anpr, "anpr_processor_started_at", 1))
        self.stack.enter_context(mock.patch.object(anpr.time, "time", return_value=1000))
        self.config = self.stack.enter_context(mock.patch.object(anpr, "load_config"))
        self.config.return_value = {"cameras": [{"name": "ENTRADA", "rtsp": "rtsp://example"}]}
        self.process = self.stack.enter_context(mock.patch.object(anpr, "process_status", return_value={"running": True}))
        self.status = self.stack.enter_context(mock.patch.object(anpr, "read_anpr_status_payload"))
        self.restart = self.stack.enter_context(mock.patch.object(anpr, "restart_anpr_from_watchdog"))
        self.stack.enter_context(mock.patch.object(anpr.os.path, "getmtime", return_value=999))
        self.stack.enter_context(mock.patch.object(
            anpr, "parse_utc_timestamp", side_effect=lambda value: {"frame": 995, "prediction": 995}.get(value)
        ))
        self.status.return_value = {"cameras": {"ENTRADA": {
            "capture_running": True,
            "processing_running": True,
            "last_frame_at": "frame",
            "last_prediction_at": "prediction",
        }}}

    def test_healthy_camera_does_not_restart(self):
        anpr.check_anpr_watchdog()
        self.restart.assert_not_called()

    def test_missing_status_restarts(self):
        self.status.return_value = None
        anpr.check_anpr_watchdog()
        self.restart.assert_called_once_with("El archivo de estado ANPR no esta disponible")

    def test_stale_snapshot_restarts(self):
        with mock.patch.object(anpr.os.path, "getmtime", return_value=800):
            anpr.check_anpr_watchdog()
        self.restart.assert_called_once_with("La imagen de la camara no se actualiza", "ENTRADA")

    def test_dead_process_restarts(self):
        self.process.return_value = {"running": False}
        anpr.check_anpr_watchdog()
        self.restart.assert_called_once_with("El proceso ANPR no esta en ejecucion")

    def test_disabled_camera_does_not_restart(self):
        self.config.return_value["cameras"][0]["watchdog_enabled"] = False
        anpr.check_anpr_watchdog()
        self.process.assert_not_called()
        self.restart.assert_not_called()

    def test_manual_stop_does_not_restart(self):
        with mock.patch.object(anpr, "anpr_processor_expected_running", False):
            anpr.check_anpr_watchdog()
        self.restart.assert_not_called()


if __name__ == "__main__":
    unittest.main()
