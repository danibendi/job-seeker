from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from scripts.compass_worker.client import CompassClient, TaskClaim
from scripts.compass_worker.codex import DISABLED_FEATURES, CodexAdapter, classify_codex_failure
from scripts.compass_worker.evaluation import ModelEffortProfile
from scripts.compass_worker.runner import AdapterResult, WorkerRunner


class _Control:
    cancelled = False
    reason = None

    def report_progress(self, **kwargs: object) -> bool:
        return True


def _claim(kind: str, payload: dict[str, object]) -> TaskClaim:
    return TaskClaim(
        task={"id": "task-1", "kind": kind, "executor": "codex", "attemptCount": 1, "payload": payload},
        claim_token="task-capability",
        lease_expires_at=None,
        heartbeat_interval_seconds=30,
    )


_RECORDING_CODEX = """import json, os, sys
prompt = sys.stdin.read()
argv = sys.argv[1:]
open(RECORD_PATH, 'w').write(json.dumps({
    'argv': argv,
    'cwd': os.getcwd(),
    'browser_token': os.environ.get('COMPASS_CODEX_BROWSER_MCP_TOKEN'),
    'codex_home': os.environ.get('CODEX_HOME'),
}))
print(json.dumps({'type': 'thread.started', 'thread_id': 'opaque'}))
print(json.dumps({'type': 'item.completed', 'item': {'type': 'mcp_tool_call', 'server': 'compass', 'tool': 'get_task_context', 'status': 'completed'}}))
print(json.dumps({'type': 'item.completed', 'item': {'type': 'web_search', 'query': 'private query text'}}))
print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 1200, 'cached_input_tokens': 800, 'output_tokens': 90}}))
output = argv[argv.index('--output-last-message') + 1]
open(output, 'w').write(json.dumps({'status': 'succeeded', 'summary': 'Done', 'details': '{}', 'artifacts': [], 'checkpoint': 'null', 'retryable': False}))
"""


class CodexTaskProfileTest(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)
        self.record = self.root / "record.json"

    def tearDown(self) -> None:
        self._directory.cleanup()

    def _executable(self, body: str) -> Path:
        path = self.root / "fake-codex"
        path.write_text("#!/usr/bin/env python3\n" + body, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def _adapter(self, executable: Path, **kwargs: object) -> CodexAdapter:
        options: dict[str, object] = {
            "codex_bin": str(executable),
            "timeout_seconds": 10,
            "source_env": {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "")},
        }
        options.update(kwargs)
        return CodexAdapter("https://compass.example.com", **options)  # type: ignore[arg-type]

    def _recorded(self) -> dict[str, object]:
        return json.loads(self.record.read_text(encoding="utf-8"))

    @staticmethod
    def _config(argv: list[str]) -> list[str]:
        return [argv[index + 1] for index, value in enumerate(argv) if value == "-c"]

    def test_question_is_isolated_and_never_requires_the_browser(self) -> None:
        executable = self._executable(_RECORDING_CODEX.replace("RECORD_PATH", repr(str(self.record))))
        adapter = self._adapter(
            executable,
            model="gpt-general",
            reasoning_effort="medium",
            kind_profiles={"linkedin_evaluate": ModelEffortProfile(model="gpt-light", reasoning="low")},
            browser_mcp_url="http://127.0.0.1:9/mcp",
            browser_mcp_token="browser-capability",
            browser_mcp_enabled_tools=("navigate",),
        )
        result = adapter.run(_claim("question", {"candidateId": "demo"}), _Control())
        recorded = self._recorded()
        argv = recorded["argv"]
        assert isinstance(argv, list)
        config = self._config(argv)

        self.assertEqual(result.status, "succeeded")
        self.assertIn('web_search="disabled"', config)
        self.assertFalse(any(item.startswith("mcp_servers.browser") for item in config))
        self.assertIsNone(recorded["browser_token"])
        self.assertEqual(argv[argv.index("--sandbox") + 1], "read-only")
        self.assertEqual(argv[argv.index("--model") + 1], "gpt-general")
        self.assertIn('model_reasoning_effort="medium"', config)
        for feature in ("shell_tool", "apps", "plugins", "hooks", "computer_use"):
            self.assertIn(feature, DISABLED_FEATURES)
            self.assertIn(feature, [argv[index + 1] for index, value in enumerate(argv) if value == "--disable"])
        workspace = Path(argv[argv.index("--cd") + 1])
        self.assertEqual(Path(str(recorded["cwd"])), workspace)
        self.assertTrue(workspace.name == "workspace" and workspace.parent.name.startswith("compass-codex-"))
        self.assertFalse(workspace.exists(), "the per-task workspace must be removed after the run")
        run = result.result["worker_run"]
        self.assertEqual(run["model"], "gpt-general")
        self.assertEqual(run["reasoning_effort"], "medium")
        self.assertEqual(run["usage"], {"cached_input_tokens": 800, "input_tokens": 1200, "output_tokens": 90})
        self.assertEqual(run["tool_calls"], {"compass.get_task_context": 1, "web_search": 1})
        self.assertNotIn("private query text", json.dumps(result.result))

    def test_public_search_gets_live_web_and_evaluation_uses_its_own_profile(self) -> None:
        executable = self._executable(_RECORDING_CODEX.replace("RECORD_PATH", repr(str(self.record))))
        adapter = self._adapter(
            executable,
            model="gpt-general",
            reasoning_effort="medium",
            kind_profiles={"linkedin_evaluate": ModelEffortProfile(model="gpt-light", reasoning="low")},
        )
        adapter.run(_claim("search", {"sources": ["public"]}), _Control())
        self.assertIn('web_search="live"', self._config(self._recorded()["argv"]))  # type: ignore[arg-type]

        evaluation = adapter.run(_claim("linkedin_evaluate", {"snapshotId": "s1"}), _Control())
        argv = self._recorded()["argv"]
        assert isinstance(argv, list)
        self.assertEqual(argv[argv.index("--model") + 1], "gpt-light")
        self.assertIn('model_reasoning_effort="low"', self._config(argv))
        self.assertIn('web_search="disabled"', self._config(argv))
        self.assertEqual(evaluation.result["worker_run"]["reasoning_effort"], "low")

    def test_dedicated_codex_home_replaces_the_inherited_one(self) -> None:
        executable = self._executable(_RECORDING_CODEX.replace("RECORD_PATH", repr(str(self.record))))
        home = self.root / "worker-codex-home"
        home.mkdir()
        adapter = self._adapter(executable, codex_home=home)
        adapter.source_env["CODEX_HOME"] = str(self.root / "personal")
        adapter.check()
        adapter.run(_claim("question", {}), _Control())
        self.assertEqual(self._recorded()["codex_home"], str(home.resolve()))

    def test_usage_limit_holds_the_task_and_pauses_the_worker_without_raw_text(self) -> None:
        message = "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits"
        executable = self._executable(f"""import json, sys
sys.stdin.read()
print(json.dumps({{'type': 'turn.started'}}))
print(json.dumps({{'type': 'error', 'message': {message!r}}}))
print(json.dumps({{'type': 'turn.failed', 'error': {{'message': {message!r}}}}}))
raise SystemExit(1)
""")
        result = self._adapter(executable).run(_claim("question", {}), _Control())

        self.assertEqual(result.status, "waiting_for_user")
        self.assertEqual(result.pause_worker, "usage_limit")
        self.assertFalse(result.retryable)
        self.assertIn("usage limit", result.summary)
        self.assertIn("Resume the worker", result.summary)
        self.assertNotIn("chatgpt.com", result.summary)
        assert result.checkpoint is not None
        self.assertEqual(result.checkpoint["worker_run"]["failure_category"], "usage_limit")
        self.assertNotIn("chatgpt.com", json.dumps(result.checkpoint))

    def test_failure_categories_come_from_events_or_diagnostics(self) -> None:
        self.assertEqual(classify_codex_failure(["The 'x' model is not supported when using Codex with a ChatGPT account."]), "model_unavailable")
        self.assertEqual(classify_codex_failure([], "Failed to initialize session: required MCP servers failed to initialize: browser: handshaking"), "browser_unavailable")
        self.assertEqual(classify_codex_failure([], "required MCP servers failed to initialize: compass: handshaking with MCP server failed"), "task_tools_unavailable")
        self.assertEqual(classify_codex_failure([], "Error: Unknown feature flag: something_new"), "cli_incompatible")
        self.assertEqual(classify_codex_failure(["unexpected status 401 Unauthorized"]), "login_required")
        self.assertEqual(classify_codex_failure(["exceeded retry limit, last status: 429 Too Many Requests"]), "rate_limited")
        self.assertEqual(classify_codex_failure(["stream disconnected before completion"]), "network")
        self.assertIsNone(classify_codex_failure(["something unexpected"]))

    def test_terminal_error_outranks_an_earlier_transient_one(self) -> None:
        self.assertEqual(
            classify_codex_failure([
                "stream disconnected before completion: error sending request",
                "You've hit your usage limit. Try again later.",
            ]),
            "usage_limit",
        )
        executable = self._executable("""import json, sys
sys.stdin.read()
print(json.dumps({'type': 'error', 'message': 'Reconnecting... stream disconnected before completion'}))
print(json.dumps({'type': 'turn.failed', 'error': {'message': "You've hit your usage limit."}}))
raise SystemExit(1)
""")
        result = self._adapter(executable).run(_claim("question", {}), _Control())
        self.assertEqual(result.pause_worker, "usage_limit")

    def test_task_tool_or_browser_authorization_failure_is_not_a_lost_sign_in(self) -> None:
        compass = (
            "Error: thread/start failed: required MCP servers failed to initialize: compass: "
            "handshaking with MCP server failed: Transport error: HTTP 401 Unauthorized"
        )
        browser = (
            "Error: thread/start failed: required MCP servers failed to initialize: browser: "
            "handshaking with MCP server failed: HTTP status client error (401 Unauthorized)"
        )
        self.assertEqual(classify_codex_failure([], compass), "task_tools_unavailable")
        self.assertEqual(classify_codex_failure([], "rmcp error: connection refused\n" + browser), "browser_unavailable")
        executable = self._executable(f"""import sys
sys.stdin.read()
sys.stderr.write({compass!r} + '\\n')
raise SystemExit(1)
""")
        result = self._adapter(executable).run(_claim("question", {}), _Control())
        self.assertEqual(result.status, "failed")
        self.assertTrue(result.retryable)
        self.assertIsNone(result.pause_worker)

    def test_relative_executable_resolves_against_the_launch_directory(self) -> None:
        tools = self.root / "tools"
        tools.mkdir()
        executable = tools / "relative-codex"
        executable.write_text("#!/usr/bin/env python3\n" + _RECORDING_CODEX.replace("RECORD_PATH", repr(str(self.record))), encoding="utf-8")
        executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
        previous = Path.cwd()
        os.chdir(self.root)
        try:
            adapter = self._adapter(Path("tools/relative-codex"))
        finally:
            os.chdir(previous)
        adapter.check()
        result = adapter.run(_claim("question", {}), _Control())
        self.assertEqual(result.status, "succeeded")
        argv0_workspace = Path(self._recorded()["cwd"])  # type: ignore[arg-type]
        self.assertNotEqual(argv0_workspace, self.root)

    def test_login_failure_from_diagnostics_also_pauses(self) -> None:
        executable = self._executable("""import sys
sys.stdin.read()
sys.stderr.write('ERROR: Your access token could not be refreshed. Please log out and sign in again.\\n')
raise SystemExit(1)
""")
        result = self._adapter(executable).run(_claim("search", {"sources": ["public"]}), _Control())
        self.assertEqual(result.status, "waiting_for_user")
        self.assertEqual(result.pause_worker, "login_required")

    def test_unknown_exit_stays_retryable_and_records_the_run(self) -> None:
        executable = self._executable("import sys\nsys.stdin.read()\nraise SystemExit(3)\n")
        result = self._adapter(executable).run(_claim("question", {}), _Control())
        self.assertEqual(result.status, "failed")
        self.assertTrue(result.retryable)
        self.assertIsNone(result.pause_worker)
        assert result.checkpoint is not None
        self.assertEqual(result.checkpoint["worker_run"]["failure_category"], "codex_exit")


class _PausingClient:
    def __init__(self) -> None:
        self.failures: list[dict[str, object]] = []
        self.claims = 0
        self.worker_pause: dict[str, object] | None = None

    def claim(self) -> TaskClaim | None:
        self.claims += 1
        if self.claims == 1:
            return TaskClaim(
                task={"id": "held", "executor": "codex", "kind": "question"},
                claim_token="claim",
                lease_expires_at="2099-01-01T00:00:00Z",
                heartbeat_interval_seconds=30,
            )
        self.worker_pause = {"reason": "usage_limit"}
        return None

    def renew(self, task_id: str, claim_token: str) -> dict[str, object]:
        return {"lease_expires_at": "2099-01-01T00:00:00Z"}

    def fail(self, task_id: str, claim_token: str, **kwargs: object) -> dict[str, object]:
        self.failures.append(kwargs)
        return {}


class _LimitAdapter:
    def run(self, claim: TaskClaim, control: object) -> AdapterResult:
        return AdapterResult(status="waiting_for_user", summary="Usage limit reached", pause_worker="usage_limit")


class WorkerPauseTest(unittest.TestCase):
    def test_runner_sends_the_pause_and_then_drains_without_claiming_more(self) -> None:
        client = _PausingClient()
        runner = WorkerRunner(client, {"codex": _LimitAdapter()})  # type: ignore[arg-type]
        with self.assertLogs("compass_worker", level="WARNING") as logs:
            self.assertEqual(runner.run(drain=True), 0)
        self.assertEqual(client.claims, 2)
        self.assertEqual(client.failures[0]["pause_worker"], "usage_limit")
        self.assertTrue(client.failures[0]["waiting_for_user"])
        self.assertTrue(any("paused this worker" in line for line in logs.output))

    def test_pause_requires_waiting_for_user(self) -> None:
        with self.assertRaises(ValueError):
            AdapterResult(status="failed", summary="x", pause_worker="usage_limit")
        with self.assertRaises(ValueError):
            AdapterResult(status="waiting_for_user", summary="x", pause_worker="something_else")
        with self.assertRaises(ValueError):
            CompassClient("https://compass.example.com", "token").fail(
                "task", "claim", error="x", pause_worker="usage_limit"
            )


if __name__ == "__main__":
    unittest.main()
