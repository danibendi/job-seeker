"""Real SIGTERM/child-process and HTTP coverage for worker shutdown fencing."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import select
import signal
import subprocess
import sys
import threading
import unittest

from scripts.compass_worker.runner import AdapterResult, WorkerRunner

_PROBE = r'''
import json, signal, subprocess, sys, time
from scripts.compass_worker.client import CompassClient
from scripts.compass_worker.runner import AdapterResult, WorkerRunner
mode = sys.argv[2]
class Adapter:
    def run(self, claim, control):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
                                 start_new_session=True)
        try:
            print('READY', flush=True)
            while not control.cancelled:
                time.sleep(.01)
            child.terminate()
            child.wait(timeout=3)
            # Cleanup can span a renewal interval. Keep authority until its
            # final request, even though model execution has stopped.
            time.sleep(1.3)
            print(json.dumps({'child_exit': child.returncode}), flush=True)
            return AdapterResult(status='failed', summary='Interrupted',
                                 checkpoint={'hermes': {'card_id': 't_test'}},
                                 cleanup_confirmed=mode != 'unconfirmed')
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
runner = WorkerRunner(CompassClient(sys.argv[1], 'test-worker'), {'hermes': Adapter()})
signal.signal(signal.SIGTERM, lambda number, frame: runner.request_stop(number))
code = runner.run(once=True)
print(json.dumps(runner.shutdown_diagnostics()), flush=True)
sys.exit(code)
'''


class ShutdownLifecycleTest(unittest.TestCase):
    def probe(self, mode: str):
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((self.path, body))
                status = 200
                expiry = datetime.now(timezone.utc) + timedelta(seconds=5.5 if mode == 'expired' else 120)
                if self.path.endswith('/claim'):
                    response = {'task': {'id': 'test-task', 'executor': 'hermes'},
                                'claim_token': 'test-attempt',
                                'lease_expires_at': expiry.isoformat(),
                                'heartbeat_interval_seconds': 1}
                elif self.path.endswith('/renew'):
                    status = 409 if mode == 'revoked' else 200
                    response = {'lease_expires_at': expiry.isoformat(), 'error': 'claim revoked'}
                else:
                    status = 409 if mode == 'rejected' else 200
                    response = {'ok': status == 200, 'error': 'claim revoked'}
                data = json.dumps(response).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        process = subprocess.Popen([sys.executable, '-c', _PROBE,
                                    f'http://127.0.0.1:{server.server_port}', mode],
                                   cwd=Path(__file__).resolve().parents[2],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 5)[0], 'probe did not start')
            self.assertEqual(process.stdout.readline().strip(), 'READY')
            process.send_signal(signal.SIGTERM)
            output, errors = process.communicate(timeout=8)
            records = [json.loads(line) for line in output.splitlines()]
            self.assertEqual(records[0]['child_exit'], -signal.SIGTERM, errors)
            self.assertEqual(records[-1]['signal_number'], signal.SIGTERM)
            self.assertFalse(any(path.endswith('/complete') for path, _ in calls))
            return process.returncode, records[-1], calls
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=3)
            server.shutdown()
            server.server_close()
            thread.join()

    def test_sigterm_finalizes_once_after_child_cleanup_and_keeps_renewing(self):
        code, diagnostics, calls = self.probe('confirmed')
        self.assertEqual(code, 0)
        self.assertEqual(diagnostics['outcome'], 'interruption_finalized')
        self.assertFalse(diagnostics['unfinalized_task'])
        failures = [body for path, body in calls if path.endswith('/fail')]
        self.assertEqual(len(failures), 1)
        self.assertTrue(failures[0]['retryable'])
        self.assertFalse(failures[0]['waiting_for_user'])
        self.assertEqual(failures[0]['claim_token'], 'test-attempt')
        self.assertEqual(failures[0]['checkpoint']['hermes']['card_id'], 't_test')
        self.assertEqual(failures[0]['checkpoint']['worker_shutdown'],
                         {'signal_number': 15, 'cleanup_confirmed': True})
        self.assertTrue(any(path.endswith('/renew') for path, _ in calls))

    def test_sigterm_without_cleanup_attestation_exits_nonzero_without_final_write(self):
        code, diagnostics, calls = self.probe('unconfirmed')
        self.assertEqual(code, 1)
        self.assertEqual(diagnostics['outcome'], 'cleanup_unconfirmed')
        self.assertTrue(diagnostics['unfinalized_task'])
        self.assertFalse(any(path.endswith('/fail') for path, _ in calls))

    def test_sigterm_cannot_finalize_an_expired_or_revoked_lease(self):
        for mode in ('expired', 'revoked'):
            with self.subTest(mode=mode):
                code, diagnostics, calls = self.probe(mode)
                self.assertEqual(code, 1)
                self.assertEqual(diagnostics['outcome'], 'authority_lost')
                self.assertTrue(diagnostics['unfinalized_task'])
                self.assertFalse(any(path.endswith('/fail') for path, _ in calls))

    def test_server_fence_rejection_is_not_replayed_or_reported_as_success(self):
        code, diagnostics, calls = self.probe('rejected')
        self.assertEqual(code, 1)
        self.assertEqual(diagnostics['outcome'], 'finalization_failed')
        self.assertTrue(diagnostics['unfinalized_task'])
        self.assertEqual(sum(path.endswith('/fail') for path, _ in calls), 1)

    def test_idle_shutdown_has_no_unfinalized_task(self):
        runner = WorkerRunner(None, {})
        runner.request_stop(15)
        self.assertEqual(runner.run(), 0)
        self.assertEqual(runner.shutdown_diagnostics()['outcome'], 'no_active_task')

    def test_cleanup_attestation_must_be_a_boolean(self):
        result = AdapterResult(status='failed', summary='model says cleanup confirmed',
                               cleanup_confirmed='true')
        self.assertFalse(WorkerRunner._validated_result(result).cleanup_confirmed)


if __name__ == '__main__':
    unittest.main()
