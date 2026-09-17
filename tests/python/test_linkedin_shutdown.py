"""Cleanup proof must survive deterministic and mixed-source routing."""
import os
from dataclasses import replace
import unittest
from unittest.mock import patch

from scripts.compass_worker.browser import BrowserError, CloudBrowser
from scripts.compass_worker.linkedin import LinkedInCollector, SearchRoutingAdapter
from scripts.compass_worker.runner import AdapterResult, WorkerRunner
from tests.python.test_browser_lifecycle import provider
from tests.python.test_linkedin_collector import Control, SyntheticScanBackend, claim


class LinkedInShutdownTest(unittest.TestCase):
    def test_cancelled_collection_attests_only_after_provider_confirms_stop(self):
        for mode in ('normal', 'stop_pending'):
            with self.subTest(mode=mode), provider(mode) as events:
                backend = SyntheticScanBackend()
                control = Control()
                class Browser:
                    usage = {}
                    def __init__(self):
                        self.cloud = CloudBrowser('synthetic-key', 'profile-123')
                    def __enter__(self):
                        self.cloud.start()
                        return self
                    def command(self, *_args, **_kwargs):
                        control.cancelled = True
                        raise BrowserError('Compass lease lost')
                    def __exit__(self, *_args):
                        self.usage = self.cloud.stop()

                adapter = LinkedInCollector('https://synthetic.invalid',
                    browser_factory=lambda **_args: Browser(), mcp_factory=backend.factory)
                with patch.dict(os.environ, {'COMPASS_LINKEDIN_EXPECTED_NAME': 'Synthetic Account'}):
                    result = adapter.run(claim(), control)
                self.assertTrue(control.cancelled)
                self.assertIs(result.cleanup_confirmed, mode == 'normal')
                self.assertEqual(events, ['allocated', 'stop_requested'])
                if mode == 'stop_pending':
                    self.assertEqual(result.status, 'waiting_for_user')
                    self.assertFalse(result.retryable)

    def test_missing_account_before_allocation_is_clean(self):
        def unexpected_browser(**_args):
            self.fail('browser must not be allocated')
        collector = LinkedInCollector('https://synthetic.invalid',
            browser_factory=unexpected_browser, mcp_factory=lambda *_args: None)
        with patch.dict(os.environ, {'COMPASS_LINKEDIN_EXPECTED_NAME': ''}):
            result = collector.run(claim(), Control())
        self.assertTrue(result.cleanup_confirmed)

    def test_mixed_worker_shutdown_finalizes_only_after_cloud_cleanup(self):
        for mode in ('normal', 'stop_pending'):
            with self.subTest(mode=mode), provider(mode):
                failures = []
                class Client:
                    def claim(self):
                        return replace(claim(sources=['linkedin', 'public']),
                                       lease_expires_at='2099-01-01T00:00:00Z')
                    def fail(self, *args, **kwargs):
                        failures.append(kwargs)
                class Semantic:
                    def run(self, *_args):
                        raise AssertionError('no model may launch after collector shutdown')
                class Browser:
                    usage = {}
                    def __init__(self):
                        self.cloud = CloudBrowser('synthetic-key', 'profile-123')
                    def __enter__(self):
                        self.cloud.start()
                    def command(self, *_args, **_kwargs):
                        worker.request_stop(15)
                        raise BrowserError('Compass lease lost')
                    def __exit__(self, *_args):
                        self.usage = self.cloud.stop()

                routing = SearchRoutingAdapter('https://synthetic.invalid', Semantic())
                routing.collector = LinkedInCollector('https://synthetic.invalid',
                    browser_factory=lambda **_args: Browser(), mcp_factory=SyntheticScanBackend().factory)
                worker = WorkerRunner(Client(), {'hermes': routing})
                with patch.dict(os.environ, {'COMPASS_LINKEDIN_EXPECTED_NAME': 'Synthetic Account'}):
                    code = worker.run(once=True)
                self.assertEqual(code, 0 if mode == 'normal' else 1)
                self.assertEqual(len(failures), 1 if mode == 'normal' else 0)
                if failures:
                    self.assertTrue(failures[0]['retryable'])
                self.assertEqual(worker.shutdown_diagnostics()['outcome'],
                                 'interruption_finalized' if mode == 'normal' else 'cleanup_unconfirmed')

    def test_mixed_result_requires_both_stages_cleanup_proof(self):
        class Stage:
            def __init__(self, result):
                self.result = result
                self.calls = 0
            def run(self, *_args):
                self.calls += 1
                return self.result

        for collection_clean, semantic_clean in ((True, True), (True, False), (False, True)):
            for path in ('semantic', 'progress_rejected', 'insufficient_budget'):
                with self.subTest(collection=collection_clean, semantic=semantic_clean, path=path):
                    semantic = Stage(AdapterResult(status='failed', summary='interrupted',
                                                   cleanup_confirmed=semantic_clean))
                    adapter = SearchRoutingAdapter('https://synthetic.invalid', semantic)
                    adapter.collector = Stage(AdapterResult(status='succeeded', summary='collected',
                                                            cleanup_confirmed=collection_clean))
                    control = Control()
                    if path == 'progress_rejected':
                        control.report_progress = lambda **_args: False
                    task = claim(sources=['linkedin', 'public'],
                                 max_seconds=20 if path == 'insufficient_budget' else 300)
                    result = adapter.run(task, control)
                    expected = collection_clean and semantic_clean if path == 'semantic' else collection_clean
                    self.assertIs(result.cleanup_confirmed, expected)
                    self.assertEqual(semantic.calls, 1 if path == 'semantic' else 0)


if __name__ == '__main__':
    unittest.main()
