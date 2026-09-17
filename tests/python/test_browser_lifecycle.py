"""Actual HTTP transport failures must not allocate a second cloud session."""
from contextlib import contextmanager
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.compass_worker import browser as browser_module
from scripts.compass_worker.browser import CloudBrowser, CloudLifecycleUncertain
from scripts.compass_worker.client import TaskClaim
from scripts.compass_worker.linkedin import LinkedInCollector


@contextmanager
def provider(mode):
    events = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, body, status=200):
            self.send_response(status)
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())

        def do_POST(self):
            events.append('allocated')
            if mode == 'lost_response':
                self.close_connection = True
            elif mode == 'server_error':
                self.reply({}, 500)
            elif mode == 'missing_id':
                self.reply({})
            else:
                self.reply({'id': 'session-123', 'status': 'active'})

        def do_PATCH(self):
            events.append('stop_requested')
            self.reply({})

        def do_GET(self):
            self.reply({'id': 'session-123', 'status': 'active' if mode == 'stop_pending' else 'stopped'})

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
    thread.start()
    try:
        with patch.object(browser_module, 'API', f'http://127.0.0.1:{server.server_port}/api/v4'):
            yield events
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class BrowserLifecycleTests(unittest.TestCase):
    def test_direct_connectivity_sends_explicit_null_not_provider_default_proxy(self):
        with patch.dict(os.environ, {'BROWSER_USE_API_KEY': 'synthetic-key', 'COMPASS_LINKEDIN_PROFILE_ID': 'profile-123',
                                     'COMPASS_LINKEDIN_PROXY_COUNTRY': 'direct'}, clear=True):
            browser = browser_module.configured_browser()
        with patch.object(browser.cloud, 'request', return_value={'id': 'session-123', 'status': 'active'}) as request:
            browser.cloud.start()
        self.assertIn('proxyCountryCode', request.call_args.args[2])
        self.assertIsNone(request.call_args.args[2]['proxyCountryCode'])
    def test_ambiguous_allocations_are_typed_and_never_retried(self):
        for mode in ('lost_response', 'server_error', 'missing_id'):
            with self.subTest(mode=mode), provider(mode) as events:
                cloud = CloudBrowser('synthetic-key', 'profile-123')
                with self.assertRaises(CloudLifecycleUncertain):
                    cloud.start()
                self.assertEqual(events, ['allocated'])
                self.assertIsNone(cloud.browser_id)

    def test_unconfirmed_stop_retains_recovery_id(self):
        with provider('stop_pending') as events:
            cloud = CloudBrowser('synthetic-key', 'profile-123')
            cloud.start()
            with self.assertRaises(CloudLifecycleUncertain) as raised:
                cloud.stop()
            self.assertEqual(raised.exception.browser_id, 'session-123')
            self.assertEqual(cloud.browser_id, 'session-123')
            self.assertEqual(events, ['allocated', 'stop_requested'])

    def test_confirmed_stop_finishes_normally(self):
        with provider('normal'):
            cloud = CloudBrowser('synthetic-key', 'profile-123')
            cloud.start()
            self.assertEqual(cloud.stop()['status'], 'stopped')
            self.assertIsNone(cloud.browser_id)

    def test_collector_parks_uncertain_lifecycle_for_inspection(self):
        calls = []
        class Mcp:
            def call(self, name, **_args):
                calls.append(name)
                if name == 'get_task_context':
                    return {'effectivePolicy': {'schema': 'compass.effective-search-policy',
                            'schemaVersion': 1, 'roles': {'targets': ['Engineer']},
                            'office': {'workModes': [], 'locations': []},
                            'remote': {'enabled': True, 'searchLocations': [
                                {'city': 'Brno', 'countryCode': 'CZ'},
                            ]}}, 'policyHash': 'a' * 64}
                if name == 'get_linkedin_scan_state':
                    return {'plan_hash': 'b' * 64}
                return {'state': {'plan_hash': 'b' * 64}}

        class UncertainBrowser:
            usage = {}
            def __enter__(self):
                raise CloudLifecycleUncertain('Stop requires inspection', 'session-123')
            def __exit__(self, *_args):
                pass

        collector = LinkedInCollector('https://unit.invalid', browser_factory=lambda **_args: UncertainBrowser(), mcp_factory=lambda *_args: Mcp())
        claim = TaskClaim({'id': 'task-123', 'attemptCount': 1, 'payload': {}}, 'synthetic-task-token', '2026-09-13T00:00:00Z', 30)
        with patch.dict(os.environ, {'COMPASS_LINKEDIN_EXPECTED_NAME': 'Synthetic Account'}):
            result = collector.run(claim, SimpleNamespace(cancelled=False))
        self.assertEqual(result.status, 'waiting_for_user')
        self.assertFalse(result.retryable)
        lifecycle_stop = next(stop for stop in result.checkpoint['linkedin_collection']['stops']
                              if stop['reason'] == 'cloud_lifecycle_uncertain')
        self.assertEqual(lifecycle_stop['browserId'], 'session-123')
        self.assertIn('record_linkedin_scan_stop', calls)


if __name__ == '__main__':
    unittest.main()
