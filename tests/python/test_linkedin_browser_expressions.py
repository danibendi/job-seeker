from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]


class LinkedInBrowserExpressionTest(unittest.TestCase):
    def chrome(self) -> str:
        chrome = shutil.which("google-chrome") or shutil.which("chromium")
        if not chrome:
            self.skipTest("Chrome is required for the real DOM fixture")
        return chrome

    def test_generated_dom_expressions_and_description_boundaries(self) -> None:
        chrome = self.chrome()
        completed = subprocess.run(
            [
                "node",
                str(ROOT / "tests/fixtures/verify-linkedin-dom.mjs"),
                str(ROOT / "scripts/compass_worker/linkedin_browser.mjs"),
                chrome,
            ],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-1000:])

    def test_media_blocking_uses_resource_types_and_preserves_functional_dom(self) -> None:
        completed = subprocess.run(
            [
                "node",
                str(ROOT / "tests/fixtures/verify-linkedin-media-blocking.mjs"),
                str(ROOT / "scripts/compass_worker/linkedin_browser.mjs"),
                self.chrome(),
            ],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-1000:])

    def test_stale_blocking_request_is_benign_but_other_cdp_errors_fail(self) -> None:
        completed = subprocess.run(
            [
                "node",
                str(ROOT / "tests/fixtures/verify-linkedin-blocking-race.mjs"),
                str(ROOT / "scripts/compass_worker/linkedin_browser.mjs"),
            ],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-1000:])


if __name__ == "__main__":
    unittest.main()
