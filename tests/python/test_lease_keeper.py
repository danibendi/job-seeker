from __future__ import annotations

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts.compass_worker.client import ApiError, CompassClient, TaskClaim
from scripts.compass_worker.codex import CodexAdapter
from scripts.compass_worker.runner import AdapterResult, LeaseKeeper, WorkerRunner


def expiry(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def claim(expires_at: str | None) -> TaskClaim:
    return TaskClaim(
        task={"id": "leased", "executor": "codex", "kind": "search", "attemptCount": 1},
        claim_token="test-only-claim", lease_expires_at=expires_at,
        heartbeat_interval_seconds=0.02,
    )


class LeaseKeeperTest(unittest.TestCase):
    def test_confirmed_expiry_is_monotonic_and_late_renewal_cannot_revive(self) -> None:
        clock = SimpleNamespace(wall=1_000.0, monotonic=50.0)
        with (
            mock.patch("scripts.compass_worker.runner.time.time", lambda: clock.wall),
            mock.patch("scripts.compass_worker.runner.time.monotonic", lambda: clock.monotonic),
        ):
            keeper = LeaseKeeper(None, claim(expiry(1_060)))
            self.assertEqual(keeper.lease_deadline, 105.0)
            clock.monotonic = 100
            clock.wall = -50_000  # A local clock correction cannot extend the lease.
            self.assertFalse(keeper.cancelled)
            self.assertTrue(keeper._accept_renewal({"lease_expires_at": expiry(1_120)}))
            self.assertEqual(keeper.lease_deadline, 165.0)
            clock.monotonic = 165
            self.assertTrue(keeper.cancelled)
            self.assertIn("deadline expired", keeper.reason)
            self.assertFalse(keeper._accept_renewal({"lease_expires_at": expiry(1_240)}))
            self.assertTrue(keeper.cancelled)

    def test_missing_invalid_naive_or_expired_lease_never_starts_adapter(self) -> None:
        for value in (None, "later", "2026-09-12T12:00:00", expiry(time.time() - 1)):
            with self.subTest(expiration=value):
                client = mock.Mock()
                client.claim.return_value = claim(value)
                adapter = mock.Mock()
                self.assertTrue(WorkerRunner(client, {"codex": adapter}).run_once())
                adapter.run.assert_not_called()
                client.complete.assert_not_called()
                client.fail.assert_not_called()

    def test_malformed_renewal_does_not_extend_confirmed_lease(self) -> None:
        keeper = LeaseKeeper(None, claim(expiry(time.time() + 120)))
        self.assertFalse(keeper._accept_renewal({"lease_expires_at": "later"}))
        self.assertTrue(keeper.cancelled)
        self.assertIn("renewal omitted", keeper.reason)

    def test_deadline_is_rechecked_after_completion_serialization(self) -> None:
        clock = SimpleNamespace(monotonic=50.0)
        with (
            mock.patch("scripts.compass_worker.runner.time.time", lambda: 1_000.0),
            mock.patch("scripts.compass_worker.runner.time.monotonic", lambda: clock.monotonic),
        ):
            client = mock.Mock()
            client.claim.return_value = claim(expiry(1_060))
            adapter = mock.Mock()
            adapter.run.return_value = AdapterResult(status="succeeded", summary="done")
            runner = WorkerRunner(client, {"codex": adapter})

            def slow_serialization(*args):
                clock.monotonic = 106
                return {"summary": "done"}

            with mock.patch.object(runner, "_completion_payload", slow_serialization):
                self.assertTrue(runner.run_once())
            client.complete.assert_not_called()
            client.fail.assert_not_called()


class _LeaseHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def _reply(self, value: dict, status: int = 200) -> None:
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self.server.get_count = getattr(self.server, "get_count", 0) + 1
        if getattr(self.server, "block_get", False):
            self.server.release_get.wait(3)
        self._reply({"task": {"id": "leased", "status": "running"}})

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("content-length", "0")))
        if self.path.endswith("/renew"):
            self.server.renew_count = getattr(self.server, "renew_count", 0) + 1
            self.server.renew_started.set()
            if getattr(self.server, "healthy_renewal", False):
                self._reply(
                    {"lease_expires_at": expiry(time.time() + 120)},
                    getattr(self.server, "renew_status", 200),
                )
            elif self.server.block_renewal:
                self.server.release_renewal.wait(3)
                self._reply({"lease_expires_at": expiry(time.time() + 120)})
            else:
                self._reply({"error": "temporary outage"}, 503)
        else:
            self.server.finalizations.append(self.path)
            if getattr(self.server, "hold_terminal", False):
                self.server.terminal_started.set()
                self.server.release_terminal.wait(3)
            status = getattr(self.server, "terminal_status", 200)
            self._reply({"ok": status == 200}, status)


class _ClaimClient(CompassClient):
    def claim(self) -> TaskClaim:
        # Production keeps a five-second stop margin. A 5.4-second server
        # expiration gives this accelerated fixture a 0.4-second local window.
        return claim(expiry(time.time() + 5.4))


class LeaseHttpProcessTest(unittest.TestCase):
    def test_renewal_does_not_wait_for_task_get_and_rejection_still_cancels(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _LeaseHandler)
        server.healthy_renewal = True
        server.renew_started = threading.Event()
        server.renew_count = 0
        server.get_count = 0
        server.block_get = True
        server.release_get = threading.Event()
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        client = _ClaimClient(f"http://127.0.0.1:{server.server_port}", "test-only-worker")
        keeper = LeaseKeeper(client, client.claim())
        keeper.start()
        try:
            deadline = time.monotonic() + 1
            while server.renew_count < 3 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertGreaterEqual(server.renew_count, 3)
            self.assertEqual(server.get_count, 0)
            self.assertFalse(keeper.cancelled)
            # The renewal endpoint is authoritative: a cancelled/reassigned
            # claim is rejected there without needing an extra task fetch.
            server.renew_status = 409
            deadline = time.monotonic() + 1
            while not keeper.cancelled and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(keeper.cancelled)
            self.assertIn("lease lost", keeper.reason)
            self.assertEqual(server.get_count, 0)
        finally:
            server.release_get.set()
            keeper.stop()
            server.shutdown()
            server.server_close()
            server_thread.join(2)

    def test_renewals_continue_through_delayed_terminal_writes_and_stop_afterward(self) -> None:
        for status in ("succeeded", "failed"):
            for terminal_status in (200, 503):
                with self.subTest(adapter_status=status, terminal_status=terminal_status):
                    server = ThreadingHTTPServer(("127.0.0.1", 0), _LeaseHandler)
                    server.healthy_renewal = True
                    server.hold_terminal = True
                    server.terminal_status = terminal_status
                    server.terminal_started = threading.Event()
                    server.release_terminal = threading.Event()
                    server.renew_started = threading.Event()
                    server.renew_count = 0
                    server.finalizations = []
                    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
                    server_thread.start()
                    client = _ClaimClient(f"http://127.0.0.1:{server.server_port}", "test-only-worker")
                    adapter = mock.Mock()
                    adapter.run.return_value = AdapterResult(status=status, summary="durable result")
                    runner = WorkerRunner(client, {"codex": adapter})
                    errors = []

                    def run_worker() -> None:
                        try:
                            runner.run_once()
                        except Exception as error:
                            errors.append(error)

                    worker = threading.Thread(target=run_worker, daemon=True)
                    worker.start()
                    try:
                        self.assertTrue(server.terminal_started.wait(1))
                        deadline = time.monotonic() + 1
                        while server.renew_count < 3 and time.monotonic() < deadline:
                            time.sleep(0.01)
                        self.assertGreaterEqual(server.renew_count, 3)
                        self.assertTrue(worker.is_alive(), "terminal request should still be waiting")
                        server.release_terminal.set()
                        worker.join(2)
                        self.assertFalse(worker.is_alive())
                        if terminal_status == 200:
                            self.assertEqual(errors, [])
                        else:
                            self.assertEqual(len(errors), 1)
                            self.assertIsInstance(errors[0], ApiError)
                            self.assertEqual(errors[0].status, 503)
                        expected_operation = "complete" if status == "succeeded" else "fail"
                        self.assertEqual(server.finalizations, [f"/api/worker/tasks/leased/{expected_operation}"])
                        adapter.run.assert_called_once()
                        renew_count = server.renew_count
                        time.sleep(0.06)
                        self.assertEqual(server.renew_count, renew_count, "lease thread survived finalization")
                    finally:
                        server.release_terminal.set()
                        runner.request_stop()
                        worker.join(3)
                        server.shutdown()
                        server.server_close()
                        server_thread.join(2)

    def test_http_outage_or_blocked_renewal_stops_real_child_without_finalizing(self) -> None:
        for block_renewal in (False, True):
            with self.subTest(block_renewal=block_renewal), tempfile.TemporaryDirectory() as tmp:
                server = ThreadingHTTPServer(("127.0.0.1", 0), _LeaseHandler)
                server.block_renewal = block_renewal
                server.renew_started = threading.Event()
                server.release_renewal = threading.Event()
                server.finalizations = []
                server_thread = threading.Thread(target=server.serve_forever, daemon=True)
                server_thread.start()
                root = Path(tmp)
                pid_file = root / "child.pid"
                executable = root / "codex-fixture"
                executable.write_text(
                    f"#!{sys.executable}\nimport os, time\n"
                    f"with open({str(pid_file)!r}, 'w') as output: output.write(str(os.getpid()))\n"
                    "time.sleep(60)\n"
                )
                executable.chmod(0o700)
                adapter = CodexAdapter(
                    "https://compass.example", codex_bin=str(executable), workspace=root,
                    source_env={"PATH": os.defpath},
                )
                client = _ClaimClient(f"http://127.0.0.1:{server.server_port}", "test-only-worker")
                runner = WorkerRunner(client, {"codex": adapter})
                errors = []

                def run_worker() -> None:
                    try:
                        runner.run_once()
                    except Exception as error:
                        errors.append(error)

                worker = threading.Thread(target=run_worker, daemon=True)
                worker.start()
                try:
                    self.assertTrue(server.renew_started.wait(1))
                    deadline = time.monotonic() + 1
                    while not pid_file.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(pid_file.exists(), errors)
                    pid = int(pid_file.read_text())
                    deadline = time.monotonic() + 1
                    child_stopped = False
                    while time.monotonic() < deadline:
                        try:
                            os.kill(pid, 0)
                        except ProcessLookupError:
                            child_stopped = True
                            break
                        time.sleep(0.01)
                    self.assertTrue(child_stopped, "child kept executing without a confirmed lease")
                    # In the blocked case this proves cancellation and physical
                    # child shutdown happened before any renewal response arrived.
                    self.assertFalse(server.release_renewal.is_set())
                    server.release_renewal.set()
                    worker.join(2)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(errors, [])
                    self.assertEqual(server.finalizations, [])
                finally:
                    runner.request_stop()
                    server.release_renewal.set()
                    worker.join(3)
                    server.shutdown()
                    server.server_close()
                    server_thread.join(2)


if __name__ == "__main__":
    unittest.main()
