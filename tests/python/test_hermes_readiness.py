from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
CHECKER = ROOT / "ops" / "hermes" / "check-readiness.py"


class HermesReadinessTest(unittest.TestCase):
    def run_check(self, root_config: str):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profiles = root / "profiles"
            profiles.mkdir()
            (profiles / "compass-worker.yaml").write_text("model: {}\n", encoding="utf-8")
            config = root / "config.yaml"
            config.write_text(root_config, encoding="utf-8")
            return subprocess.run(
                [
                    sys.executable, str(CHECKER),
                    "--profiles-dir", str(profiles),
                    "--root-config", str(config),
                ],
                text=True, capture_output=True, check=False,
            )

    def test_requires_false_at_root_kanban_path(self):
        accepted = self.run_check("kanban:\n  dispatch_in_gateway: false\n")
        self.assertEqual(accepted.returncode, 0, accepted.stderr)

        shadowed = self.run_check(
            "kanban:\n  dispatch_in_gateway: true\n"
            "unrelated:\n  dispatch_in_gateway: false\n"
        )
        self.assertNotEqual(shadowed.returncode, 0)
        self.assertIn("kanban.dispatch_in_gateway", shadowed.stderr)

    def test_rejects_duplicate_keys_and_non_boolean_false(self):
        duplicate = self.run_check(
            "kanban:\n  dispatch_in_gateway: false\n"
            "kanban:\n  dispatch_in_gateway: false\n"
        )
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertEqual(duplicate.stderr.strip(), "Root config is invalid or ambiguous YAML")

        string_false = self.run_check("kanban:\n  dispatch_in_gateway: 'false'\n")
        self.assertNotEqual(string_false.returncode, 0)
        self.assertIn("kanban.dispatch_in_gateway", string_false.stderr)

    def test_malformed_yaml_does_not_echo_config_content(self):
        marker = "synthetic-secret-token-do-not-echo"
        malformed = self.run_check(
            "kanban:\n"
            "  dispatch_in_gateway: false\n"
            f"secret: [{marker}\n"
        )
        self.assertNotEqual(malformed.returncode, 0)
        self.assertEqual(malformed.stderr.strip(), "Root config is invalid or ambiguous YAML")
        self.assertNotIn(marker, malformed.stdout + malformed.stderr)


if __name__ == "__main__":
    unittest.main()
