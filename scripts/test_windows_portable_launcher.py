"""Fast launcher checks without spawning/killing production servers."""
import os
import hashlib
import json
import subprocess
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

import windows_portable_launcher as launcher


class PortableLauncherTests(unittest.TestCase):
    def setUp(self):
        self.paths = launcher.layout(Path(tempfile.gettempdir()) / "portable-launch-test")
        self.identity = {"executable": os.path.normcase(os.path.realpath(self.paths["python"])),
                         "created": 123456789}
        self.state = {"pid": 123, "port": 4320, "token": "test-token", **self.identity}

    def test_local_runtime_precedes_machine_paths(self):
        with patch.dict(os.environ, {"PATH": "machine-path", "PYTHONHOME": "bad",
                                     "PYTHONPATH": "bad", "NODE_OPTIONS": "bad"}, clear=True):
            env = launcher.child_environment(self.paths, "token")
        self.assertEqual(env["PATH"].split(os.pathsep)[0], str(self.paths["node"].parent))
        self.assertFalse(any(key.startswith("PYTHON") for key in env))
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertEqual(env[launcher.TOKEN_ENV], "token")

    def test_same_token_and_exact_identity_can_reuse(self):
        with patch.object(launcher, "process_identity", return_value=self.identity), \
                patch.object(launcher, "live_config", return_value={"version": launcher.VERSION, "token": "test-token"}):
            self.assertTrue(launcher.owns_live_server(self.state, self.paths))

    def test_unrelated_server_not_reused(self):
        with patch.object(launcher, "process_identity", return_value=self.identity), \
                patch.object(launcher, "live_config", return_value={"version": launcher.VERSION, "token": "other"}):
            self.assertFalse(launcher.owns_live_server(self.state, self.paths))

    def test_malformed_token_does_not_crash(self):
        with patch.object(launcher, "process_identity", return_value=self.identity), \
                patch.object(launcher, "live_config", return_value={"version": launcher.VERSION, "token": None}):
            self.assertFalse(launcher.owns_live_server(self.state, self.paths))

    def test_stop_refuses_unverified_process(self):
        with patch.object(launcher, "owns_live_server", return_value=False), \
                patch.object(launcher, "windows_api") as winapi:
            self.assertEqual(launcher.stop_server(self.state, self.paths), 1)
            winapi.assert_not_called()

    def test_reused_pid_rejected_before_http(self):
        with patch.object(launcher, "process_identity", return_value={**self.identity, "created": 999}), \
                patch.object(launcher, "live_config") as http:
            self.assertFalse(launcher.owns_live_server(self.state, self.paths))
            http.assert_not_called()

    def test_wrong_executable_rejected(self):
        self.assertFalse(launcher.identity_matches(self.state,
                         {**self.identity, "executable": "unrelated.exe"}, self.paths))

    def test_occupied_requested_port_never_reused(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                occupied.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            with self.assertRaises(RuntimeError):
                launcher.available_port(occupied.getsockname()[1])

    def test_no_state_is_not_owned(self):
        self.assertFalse(launcher.owns_live_server(None, self.paths))
        self.assertFalse(launcher.owns_live_server({}, self.paths))

    def test_state_roundtrip(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            path = Path(temp) / "data/state.json"
            launcher.save_state(path, self.state)
            self.assertEqual(launcher.read_state(path), self.state)
            self.assertEqual(len(list(path.parent.iterdir())), 1)

    def test_real_current_process_identity(self):
        if os.name != "nt":
            self.skipTest("Windows-only process identity API")
        identity = launcher.process_identity(os.getpid())
        self.assertIsNotNone(identity)
        self.assertGreater(identity["created"], 0)

    def test_verified_avatar_cache_does_not_need_network(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            paths=launcher.layout(Path(folder))
            assets=paths['root']/'tools/gacha_ocr_prototype/assets'
            assets.mkdir(parents=True)
            data=b'synthetic-avatar'
            (assets/'test.webp').write_bytes(data)
            (assets/'manifest.json').write_text(json.dumps({'characters':[{
                'file':'test.webp','sha256':hashlib.sha256(data).hexdigest()}]}),encoding='utf-8')
            with patch.object(launcher.subprocess,'run') as run:
                launcher.prepare_avatars(paths)
            run.assert_not_called()

    def test_failed_avatar_download_still_allows_record_import_startup(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            paths=launcher.layout(Path(folder))
            assets=paths['root']/'tools/gacha_ocr_prototype/assets'
            assets.mkdir(parents=True)
            (assets/'manifest.json').write_text(json.dumps({'characters':[{
                'file':'test.webp','sha256':'0'*64}]}),encoding='utf-8')
            with patch.object(launcher.subprocess,'run',side_effect=subprocess.CalledProcessError(1,'download')) as run:
                launcher.prepare_avatars(paths)
            self.assertEqual(run.call_count,1)
            self.assertIn(str(paths['root']/'scripts/download_assets.py'),run.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
