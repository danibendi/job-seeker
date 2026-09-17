from __future__ import annotations

import unittest
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
PROFILE_FRAGMENT = REPO_ROOT / "ops" / "hermes" / "profile.example.yaml"


class CompassProfileTests(unittest.TestCase):
    def test_scoped_context_stays_inline_without_file_or_shell_access(self) -> None:
        profile = yaml.safe_load(PROFILE_FRAGMENT.read_text(encoding="utf-8"))

        # A real scoped get_task_context response crossed the default boundary
        # and was reported by Hermes as a 52 KB spillover. The override must
        # clear even a binary-KB interpretation while staying at Hermes' generic
        # per-result ceiling.
        mcp_limit = profile["tool_budget"]["mcp_result_size_chars"]
        self.assertGreater(mcp_limit, 52 * 1024)
        self.assertLessEqual(mcp_limit, 100_000)

        disabled = set(profile["agent"]["disabled_toolsets"])
        self.assertTrue({"terminal", "code_execution", "file"}.issubset(disabled))
        self.assertEqual(profile["platform_toolsets"]["cli"], ["compass", "web"])


if __name__ == "__main__":
    unittest.main()
