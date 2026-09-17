from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from typing import Any

from scripts.compass_worker.client import TaskClaim
from scripts.compass_worker.hermes import HermesKanbanAdapter, HermesOwnershipError


class FakeControl:
    def __init__(self) -> None:
        self.cancelled = False
        self.reason = None
        self.lease_deadline = time.monotonic() + 120
        self.progress: list[dict[str, Any]] = []

    def report_progress(self, **kwargs: Any) -> bool:
        self.progress.append(kwargs)
        return True


class ScriptedHermes:
    def __init__(
        self,
        *,
        terminal_status: str = "done",
        block_kind: str | None = None,
    ):
        self.calls: list[tuple[list[str], dict[str, str]]] = []
        self.card_statuses = ["ready", "ready", "running", terminal_status]
        self.block_kind = block_kind
        self.archived: set[str] = set()
        self.assignee = "compass-worker"

    def __call__(
        self,
        argv: list[str],
        **kwargs: Any,
    ) -> subprocess.CompletedProcess[str]:
        env = kwargs["env"]
        self.calls.append((list(argv), dict(env)))
        if argv[2:4] == ["boards", "create"]:
            return subprocess.CompletedProcess(argv, 0, "Board created\n", "")
        if "create" in argv and "--idempotency-key" in argv:
            card = {
                "id": "t_12345678",
                "status": "blocked",
                "assignee": "compass-worker-staging",
            }
            return subprocess.CompletedProcess(argv, 0, json.dumps(card), "")
        if "assign" in argv:
            self.assignee = argv[-1]
            return subprocess.CompletedProcess(argv, 0, "ok\n", "")
        if any(command in argv for command in ("reopen-review", "comment", "unblock")):
            return subprocess.CompletedProcess(argv, 0, "ok\n", "")
        if "archive" in argv:
            self.archived.add(argv[-1])
            return subprocess.CompletedProcess(argv, 0, "ok\n", "")
        if "list" in argv:
            cards = [{
                "id": "t_12345678",
                "status": "ready",
                "title": "Compass search: task-1",
                "body": (
                    "Compass worker card (compass-hermes-v1).\n"
                    "Compass task_id: task-1\n"
                    "Compass attempt: 2\n"
                ),
                "assignee": "compass-worker",
                "tenant": "job-seeker",
                "created_by": "compass-worker",
            }]
            return subprocess.CompletedProcess(argv, 0, json.dumps(cards), "")
        if "dispatch" in argv:
            return subprocess.CompletedProcess(
                argv,
                0,
                json.dumps({"spawned": [{
                    "task_id": "t_12345678",
                    "assignee": "compass-worker",
                }]}),
                "",
            )
        if "show" in argv:
            card_id = argv[argv.index("show") + 1]
            status = "archived" if card_id in self.archived else (
                self.card_statuses.pop(0)
                if len(self.card_statuses) > 1
                else self.card_statuses[0]
            )
            events = []
            if status in {"blocked", "triage"}:
                events = [{
                    "kind": "blocked",
                    "payload": {
                        "kind": self.block_kind,
                        "reason": "Sign in is required",
                    },
                }]
            state = {
                "task": {
                    "id": "t_12345678",
                    "status": status,
                    "assignee": self.assignee,
                    "result": None,
                },
                "latest_summary": (
                    "Found two matching roles" if status == "done" else None
                ),
                "events": events,
                "comments": [{
                    "author": "compass-worker",
                    "body": "Compass execution_ref: t_12345678",
                }],
                "runs": [{
                    "metadata": {
                        "compass_result": {"matches": 2},
                        "compass_checkpoint": {"pages": 4},
                    },
                }] if status == "done" else [],
            }
            return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
        if "reclaim" in argv or "block" in argv:
            return subprocess.CompletedProcess(argv, 0, "ok\n", "")
        raise AssertionError(f"Unexpected Hermes argv: {argv}")


def claim(attempt: int = 2) -> TaskClaim:
    return TaskClaim(
        task={
            "id": "task-1",
            "kind": "search",
            "executor": "hermes",
            "attemptCount": attempt,
            "payload": {"budgets": {"maxDurationSeconds": 120}},
            "checkpoint": {"page": 1},
        },
        claim_token="bridge-claim-secret",
        lease_expires_at=None,
        heartbeat_interval_seconds=30,
    )


class HermesAdapterTest(unittest.TestCase):
    def test_executable_lookup_matches_actual_launch_for_relative_paths(self) -> None:
        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "bin").mkdir()
            fixture = (
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "print(json.dumps({'argv0': sys.argv[0], 'cwd': os.getcwd(), "
                "'real_bin': os.environ.get('COMPASS_HERMES_REAL_BIN'), "
                "'broad_token_present': 'COMPASS_WORKER_TOKEN' in os.environ}))\n"
            )
            for path in (root / "fixture-hermes", root / "bin/fixture-hermes"):
                path.write_text(fixture)
                path.chmod(0o700)
            os.chdir(root)
            try:
                for executable, path_value, expected in (
                    ("fixture-hermes", "", root / "fixture-hermes"),
                    ("fixture-hermes", "bin", root / "bin/fixture-hermes"),
                    ("./bin/fixture-hermes", "/usr/bin", root / "bin/fixture-hermes"),
                ):
                    with self.subTest(executable=executable, path_value=path_value):
                        adapter = HermesKanbanAdapter(
                            "https://compass.example", hermes_bin=executable,
                            source_env={"PATH": path_value, "COMPASS_WORKER_TOKEN": "test-only-broad"},
                        )
                        adapter.check()
                        for dispatch in (False, True):
                            result = adapter._run_cli(
                                ["dispatch" if dispatch else "list", "--json"],
                                json_output=True, dispatch=dispatch, card_id="t_expected",
                                task_id="task-1", attempt=1, task_token="test-only-claim",
                                lease_deadline=time.monotonic() + 120,
                            )
                            self.assertEqual(result["argv0"], str(expected))
                            self.assertEqual(result["cwd"], str(root))
                            self.assertFalse(result["broad_token_present"])
                            self.assertEqual(result["real_bin"], str(expected) if dispatch else None)
                directory = HermesKanbanAdapter(
                    "https://compass.example", hermes_bin="./bin", source_env={"PATH": ""},
                )
                with self.assertRaises(ValueError):
                    directory.check()
            finally:
                os.chdir(original_cwd)

    def adapter(
        self,
        scripted: ScriptedHermes,
        **kwargs: Any,
    ) -> HermesKanbanAdapter:
        return HermesKanbanAdapter(
            "https://compass.example",
            hermes_bin=sys.executable,
            source_env={
                "PATH": "/usr/bin",
                "HOME": "/tmp/test-user",
                "COMPASS_WORKER_TOKEN": "broad-worker-secret",
                "COMPASS_HERMES_AGENT_TOKEN": "stale-static-secret",
            },
            command_runner=scripted,
            sleeper=lambda _: None,
            poll_seconds=0.01,
            **kwargs,
        )

    def test_native_card_dispatch_and_result_mapping(self) -> None:
        scripted = ScriptedHermes()
        control = FakeControl()
        result = self.adapter(scripted).run(claim(), control)

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.result, {"matches": 2})
        self.assertEqual(result.checkpoint, {"pages": 4})
        self.assertEqual(control.progress[0]["external_ref"], "t_12345678")
        self.assertEqual(control.progress[0]["checkpoint"]["page"], 1)
        self.assertEqual(
            control.progress[0]["checkpoint"]["hermes"]["attempt"],
            2,
        )

        create_argv = next(
            argv for argv, _ in scripted.calls if "--idempotency-key" in argv
        )
        key_index = create_argv.index("--idempotency-key") + 1
        self.assertEqual(
            create_argv[key_index],
            "task:task-1:attempt:2",
        )
        body = create_argv[create_argv.index("--body") + 1]
        self.assertIn("Read the adapter-authored `Compass execution_ref:` card comment", body)
        self.assertIn("Use scoped Compass MCP", body)
        self.assertNotIn("bridge-claim-secret", body)
        self.assertNotIn("stale-static-secret", body)
        self.assertEqual(
            create_argv[create_argv.index("--assignee") + 1],
            "compass-worker-staging",
        )
        self.assertEqual(create_argv[create_argv.index("--initial-status") + 1], "blocked")
        comment_argv = next(argv for argv, _ in scripted.calls if "comment" in argv)
        self.assertIn("Compass execution_ref: t_12345678", comment_argv)
        assign_argv = next(argv for argv, _ in scripted.calls if "assign" in argv)
        self.assertEqual(assign_argv[-2:], ["t_12345678", "compass-worker"])
        unblock_index = next(i for i, (argv, _) in enumerate(scripted.calls) if "unblock" in argv)
        assign_index = next(i for i, (argv, _) in enumerate(scripted.calls) if "assign" in argv)
        self.assertGreater(unblock_index, assign_index)

        dispatch_calls = [
            (argv, env) for argv, env in scripted.calls if "dispatch" in argv
        ]
        self.assertEqual(len(dispatch_calls), 2)
        self.assertIn("--dry-run", dispatch_calls[0][0])
        self.assertNotIn("COMPASS_TASK_TOKEN", dispatch_calls[0][1])
        self.assertEqual(
            dispatch_calls[1][1]["COMPASS_TASK_TOKEN"],
            "bridge-claim-secret",
        )
        self.assertEqual(dispatch_calls[1][1]["COMPASS_TASK_ID"], "task-1")
        self.assertEqual(dispatch_calls[1][1]["COMPASS_HERMES_EXPECTED_CARD"], "t_12345678")
        self.assertTrue(dispatch_calls[1][1]["HERMES_BIN"].endswith("hermes_launch.py"))
        for argv, env in scripted.calls:
            self.assertNotIn("bridge-claim-secret", "\0".join(argv))
            self.assertNotIn("COMPASS_WORKER_TOKEN", env)
            self.assertNotIn("COMPASS_HERMES_AGENT_TOKEN", env)
            if "dispatch" not in argv or "--dry-run" in argv:
                self.assertNotIn("COMPASS_TASK_TOKEN", env)

    def test_board_setup_is_memoized_while_ordinary_search_still_stages_and_dispatches(self) -> None:
        scripted = ScriptedHermes()
        scripted.card_statuses = ["ready", "ready", "running", "done"] * 2
        adapter = self.adapter(scripted)

        self.assertEqual(adapter.run(claim(attempt=2), FakeControl()).status, "succeeded")
        self.assertEqual(adapter.run(claim(attempt=2), FakeControl()).status, "succeeded")

        board_creates = [argv for argv, _ in scripted.calls if argv[2:4] == ["boards", "create"]]
        self.assertEqual(len(board_creates), 1)
        card_creates = [argv for argv, _ in scripted.calls if "--idempotency-key" in argv]
        self.assertEqual(len(card_creates), 2)
        self.assertTrue(all(argv[argv.index("--assignee") + 1] == "compass-worker-staging" for argv in card_creates))
        self.assertEqual(sum("comment" in argv for argv, _ in scripted.calls), 2)
        self.assertEqual(sum("assign" in argv for argv, _ in scripted.calls), 2)
        self.assertEqual(sum("unblock" in argv for argv, _ in scripted.calls), 2)
        self.assertEqual(sum("dispatch" in argv for argv, _ in scripted.calls), 4)

    def test_refuses_to_dispatch_an_unowned_ready_card(self) -> None:
        scripted = ScriptedHermes()
        original = scripted.__call__

        def runner(
            argv: list[str],
            **kwargs: Any,
        ) -> subprocess.CompletedProcess[str]:
            if "list" in argv:
                return subprocess.CompletedProcess(argv, 0, json.dumps([{
                    "id": "t_other",
                    "title": "Manual task",
                    "body": "not a Compass card",
                    "assignee": "compass-worker",
                    "tenant": "job-seeker",
                    "created_by": "user",
                }]), "")
            if "show" in argv:
                state = {
                    "task": {
                        "id": "t_12345678",
                        "status": "ready",
                        "result": None,
                    },
                    "latest_summary": None,
                    "events": [],
                    "runs": [],
                }
                return subprocess.CompletedProcess(
                    argv, 0, json.dumps(state), ""
                )
            return original(argv, **kwargs)

        adapter = HermesKanbanAdapter(
            "https://compass.example",
            hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"},
            command_runner=runner,
            sleeper=lambda _: None,
            poll_seconds=0.01,
        )
        result = adapter.run(claim(), FakeControl())
        self.assertEqual(result.status, "failed")
        self.assertFalse(result.retryable)
        self.assertIn("outside adapter ownership", result.summary)
        self.assertFalse(
            any("dispatch" in argv for argv, _ in scripted.calls)
        )

    def test_archived_unowned_cards_do_not_block_either_ownership_scan(self) -> None:
        for force_refresh in (False, True):
            with self.subTest(force_refresh=force_refresh):
                scripted = ScriptedHermes()
                original = scripted.__call__
                list_count = 0

                def runner(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
                    nonlocal list_count
                    completed = original(argv, **kwargs)
                    if "list" not in argv:
                        return completed
                    list_count += 1
                    cards = json.loads(completed.stdout)
                    if force_refresh and list_count == 1:
                        cards = []
                    cards.append({"id": "t_old_manual", "status": "archived"})
                    return subprocess.CompletedProcess(argv, 0, json.dumps(cards), "")

                result = self.adapter(runner).run(claim(), FakeControl())
                self.assertEqual(result.status, "succeeded")
                self.assertEqual(list_count, 2 if force_refresh else 1)

    def test_candidate_changes_after_preview_gate_refuses_before_cleanup(self) -> None:
        scripted = ScriptedHermes()
        original = scripted.__call__
        gate_refused = False

        def runner(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            nonlocal gate_refused
            if "dispatch" in argv and "--dry-run" not in argv:
                # Simulate native selection changing between the credential-free
                # preview and real tick. Execute the actual trusted gate using
                # exactly the environment this adapter gave the dispatcher.
                env = {**kwargs["env"], "HERMES_KANBAN_TASK": "t_raced",
                       "HERMES_KANBAN_BOARD": "compass", "HERMES_PROFILE": "compass-worker",
                       "HERMES_KANBAN_RUN_ID": "9", "HERMES_KANBAN_CLAIM_LOCK": "lock"}
                result = subprocess.run(
                    [env["HERMES_BIN"], "-p", "compass-worker", "--cli", "--accept-hooks",
                     "chat", "-q", "work kanban task t_raced"],
                    env=env, capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 78)
                self.assertNotIn("bridge-claim-secret", result.stdout + result.stderr)
                gate_refused = True
                return subprocess.CompletedProcess(argv, 0, json.dumps({"spawned": [{
                    "task_id": "t_raced", "assignee": "compass-worker",
                }]}), "")
            if "show" in argv and "t_raced" in argv:
                self.assertTrue(gate_refused, "cleanup cannot be the capability fence")
                return subprocess.CompletedProcess(
                    argv, 0, json.dumps({"task": {"id": "t_raced", "status": "ready"}}), ""
                )
            return original(argv, **kwargs)

        with self.assertRaisesRegex(HermesOwnershipError, "did not match"):
            self.adapter(runner)._dispatch_once(
                card_id="t_12345678", task_id="task-1", attempt=2,
                task_token="bridge-claim-secret",
                control=FakeControl(),
            )
        self.assertTrue(gate_refused)

    def test_refuses_unowned_cards_in_every_native_dispatch_lane(self) -> None:
        for status in ("review", "running"):
            with self.subTest(status=status):
                scripted = ScriptedHermes()
                original = scripted.__call__

                def runner(
                    argv: list[str],
                    **kwargs: Any,
                ) -> subprocess.CompletedProcess[str]:
                    if "list" in argv:
                        return subprocess.CompletedProcess(argv, 0, json.dumps([{
                            "id": "t_other",
                            "status": status,
                            "title": "Manual task",
                            "body": "not a Compass card",
                            "assignee": "compass-worker",
                            "tenant": "job-seeker",
                            "created_by": "user",
                        }]), "")
                    return original(argv, **kwargs)

                adapter = HermesKanbanAdapter(
                    "https://compass.example",
                    hermes_bin=sys.executable,
                    source_env={"PATH": "/usr/bin"},
                    command_runner=runner,
                    sleeper=lambda _: None,
                    poll_seconds=0.01,
                )
                result = adapter.run(claim(), FakeControl())
                self.assertEqual(result.status, "failed")
                self.assertFalse(result.retryable)
                self.assertIn("outside adapter ownership", result.summary)
                self.assertFalse(
                    any("dispatch" in argv for argv, _ in scripted.calls)
                )

    def test_refuses_credential_dispatch_without_execution_reference(self) -> None:
        scripted = ScriptedHermes()
        original = scripted.__call__
        show_count = 0

        def runner(
            argv: list[str],
            **kwargs: Any,
        ) -> subprocess.CompletedProcess[str]:
            nonlocal show_count
            completed = original(argv, **kwargs)
            if "show" not in argv:
                return completed
            show_count += 1
            if show_count != 2:
                return completed
            state = json.loads(completed.stdout)
            state["comments"] = []
            return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")

        adapter = HermesKanbanAdapter(
            "https://compass.example",
            hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"},
            command_runner=runner,
            sleeper=lambda _: None,
            poll_seconds=0.01,
        )
        result = adapter.run(claim(), FakeControl())

        self.assertEqual(result.status, "failed")
        self.assertFalse(result.retryable)
        self.assertIn("missing its execution reference", result.summary)
        credential_dispatches = [
            env for argv, env in scripted.calls
            if "dispatch" in argv and "--dry-run" not in argv
        ]
        self.assertEqual(credential_dispatches, [])

    def test_earlier_owned_card_returns_actionable_wait_without_token(self) -> None:
        scripted = ScriptedHermes()
        original = scripted.__call__

        def runner(
            argv: list[str],
            **kwargs: Any,
        ) -> subprocess.CompletedProcess[str]:
            if "list" in argv:
                current = json.loads(original(argv, **kwargs).stdout)[0]
                earlier = {
                    **current,
                    "id": "t_earlier",
                    "title": "Compass search: old-task",
                    "body": (
                        "Compass worker card (compass-hermes-v1).\n"
                        "Compass task_id: old-task\n"
                        "Compass attempt: 1\n"
                    ),
                }
                return subprocess.CompletedProcess(
                    argv, 0, json.dumps([earlier, current]), ""
                )
            return original(argv, **kwargs)

        adapter = HermesKanbanAdapter(
            "https://compass.example",
            hermes_bin=sys.executable,
            source_env={
                "PATH": "/usr/bin",
                "COMPASS_WORKER_TOKEN": "broad-worker-secret",
            },
            command_runner=runner,
            sleeper=lambda _: None,
            poll_seconds=0.01,
        )
        result = adapter.run(claim(), FakeControl())

        self.assertEqual(result.status, "waiting_for_user")
        self.assertIn("t_earlier", result.summary)
        self.assertIn("inspect and park or complete", result.summary)
        self.assertFalse(any(
            "COMPASS_TASK_TOKEN" in env
            for _, env in scripted.calls
        ))
        self.assertFalse(any(
            "dispatch" in argv
            for argv, _ in scripted.calls
        ))

    def test_earlier_staged_card_does_not_block_dispatchable_current_card(self) -> None:
        scripted = ScriptedHermes()
        original = scripted.__call__

        def runner(
            argv: list[str],
            **kwargs: Any,
        ) -> subprocess.CompletedProcess[str]:
            if "list" in argv:
                current = json.loads(original(argv, **kwargs).stdout)[0]
                staged = {
                    **current,
                    "id": "t_staged",
                    "title": "Compass search: old-task",
                    "body": (
                        "Compass worker card (compass-hermes-v1).\n"
                        "Compass task_id: old-task\n"
                        "Compass attempt: 1\n"
                    ),
                    "assignee": "compass-worker-staging",
                }
                return subprocess.CompletedProcess(
                    argv, 0, json.dumps([staged, current]), ""
                )
            return original(argv, **kwargs)

        adapter = HermesKanbanAdapter(
            "https://compass.example",
            hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"},
            command_runner=runner,
            sleeper=lambda _: None,
            poll_seconds=0.01,
        )

        result = adapter.run(claim(), FakeControl())

        self.assertEqual(result.status, "succeeded")
        credential_dispatches = [
            (argv, env)
            for argv, env in scripted.calls
            if "dispatch" in argv and "--dry-run" not in argv
        ]
        self.assertEqual(len(credential_dispatches), 1)
        self.assertEqual(credential_dispatches[0][1]["COMPASS_TASK_ID"], "task-1")
        self.assertEqual(
            credential_dispatches[0][1]["COMPASS_TASK_TOKEN"],
            "bridge-claim-secret",
        )

    def test_needs_input_block_maps_to_waiting_for_user(self) -> None:
        scripted = ScriptedHermes(
            terminal_status="blocked",
            block_kind="needs_input",
        )
        result = self.adapter(scripted).run(claim(), FakeControl())
        self.assertEqual(result.status, "waiting_for_user")
        self.assertIn("Sign in", result.summary)
        self.assertTrue(result.cleanup_confirmed)
        self.assertTrue(any("archive" in argv for argv, _ in scripted.calls))

    def test_done_requires_both_compass_objects_from_the_latest_run(self) -> None:
        complete = {"compass_result": {"matches": 2}, "compass_checkpoint": {"pages": 4}}
        invalid_runs = [
            None, [], [{}], [{"metadata": None}], [{"metadata": "not an object"}],
            [{"metadata": {"compass_checkpoint": {}}}],
            [{"metadata": {"compass_result": {}}}],
            [{"metadata": {"compass_result": [], "compass_checkpoint": {}}}],
            [{"metadata": {"compass_result": None, "compass_checkpoint": {}}}],
            [{"metadata": {"compass_result": {}, "compass_checkpoint": []}}],
            [{"metadata": {"compass_result": {}, "compass_checkpoint": "not an object"}}],
            [{"metadata": complete}, {}],
            [{"metadata": complete}, {"metadata": {"compass_result": {}}}],
        ]
        for index, runs in enumerate(invalid_runs):
            with self.subTest(case=index):
                scripted = ScriptedHermes()
                original = scripted.__call__

                def runner(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
                    completed = original(argv, **kwargs)
                    if "show" in argv:
                        state = json.loads(completed.stdout)
                        if state["task"]["status"] == "done":
                            state["runs"] = runs
                            return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
                    return completed

                result = self.adapter(runner).run(claim(), FakeControl())
                self.assertEqual(result.status, "failed")
                self.assertTrue(result.retryable)
                self.assertEqual(result.result, {})
                self.assertEqual(result.checkpoint, {"hermes": {"status": "done"}})
                self.assertIn("result and checkpoint metadata", result.summary)

    def test_done_accepts_complete_latest_metadata_including_empty_objects(self) -> None:
        for metadata in (
            {"compass_result": {}, "compass_checkpoint": {}},
            {"compass_result": {"matches": 2}, "compass_checkpoint": {"pages": 4}},
        ):
            with self.subTest(metadata=metadata):
                result = self.adapter(ScriptedHermes())._terminal_result({
                    "task": {"status": "done"}, "latest_summary": "Durable work saved",
                    "runs": [{"metadata": None}, {"metadata": metadata}],
                })
                self.assertEqual(result.status, "succeeded")
                self.assertEqual(result.summary, "Durable work saved")
                self.assertEqual(result.result, metadata["compass_result"])
                self.assertEqual(result.checkpoint, metadata["compass_checkpoint"])

    def test_transient_block_is_retryable_failure(self) -> None:
        scripted = ScriptedHermes(
            terminal_status="blocked",
            block_kind="transient",
        )
        result = self.adapter(scripted).run(claim(), FakeControl())
        self.assertEqual(result.status, "failed")
        self.assertTrue(result.retryable)
        self.assertTrue(result.cleanup_confirmed)
        self.assertTrue(any("archive" in argv for argv, _ in scripted.calls))

    def test_review_is_archived_before_returning_waiting(self) -> None:
        scripted = ScriptedHermes(terminal_status="review")
        result = self.adapter(scripted).run(claim(), FakeControl())

        self.assertEqual(result.status, "waiting_for_user")
        self.assertTrue(result.cleanup_confirmed)
        self.assertTrue(any("archive" in argv for argv, _ in scripted.calls))
        self.assertFalse(any("block" in argv for argv, _ in scripted.calls))

    def test_model_override_is_configuration_not_task_payload(self) -> None:
        scripted = ScriptedHermes()
        adapter = self.adapter(
            scripted,
            model="gpt-configured",
            provider="provider-test",
            reasoning="low",
        )
        task_claim = claim()
        task_claim.task["payload"]["model"] = "untrusted-payload-model"
        adapter.run(task_claim, FakeControl())
        create_argv = next(
            argv for argv, _ in scripted.calls if "--idempotency-key" in argv
        )
        self.assertEqual(
            create_argv[create_argv.index("--model") + 1],
            "gpt-configured",
        )
        self.assertNotIn("--reasoning", create_argv)
        dispatch_env = next(env for argv, env in scripted.calls if "dispatch" in argv and "--dry-run" not in argv)
        self.assertEqual(dispatch_env["COMPASS_HERMES_REASONING"], "low")
        self.assertNotIn("untrusted-payload-model", create_argv)

    def test_real_slow_board_setup_consumes_task_budget_before_card_or_model(self) -> None:
        scripted = ScriptedHermes()

        def runner(argv, **kwargs):
            if argv[2:4] == ["boards", "create"]:
                subprocess.run([sys.executable, "-c", "import time; time.sleep(1.05)"],
                               check=True, timeout=kwargs["timeout"])
            return scripted(argv, **kwargs)

        result = self.adapter(runner, timeout_seconds=1).run(claim(), FakeControl())
        self.assertEqual(result.status, "failed")
        self.assertIn("time limit expired during board preparation", result.summary)
        self.assertFalse(any("--idempotency-key" in argv or "dispatch" in argv for argv, _ in scripted.calls))

    def test_expired_preparation_or_preview_never_starts_model_dispatch(self) -> None:
        for slow_stage in ("comment", "preview"):
            with self.subTest(slow_stage=slow_stage):
                now = [0.0]
                scripted = ScriptedHermes()

                def runner(argv, **kwargs):
                    if (slow_stage == "comment" and "comment" in argv) or (slow_stage == "preview" and "--dry-run" in argv):
                        now[0] += 11
                    return scripted(argv, **kwargs)

                result = self.adapter(runner, timeout_seconds=10, clock=lambda: now[0]).run(claim(), FakeControl())
                self.assertEqual(result.status, "failed")
                self.assertIn("time limit", result.summary)
                self.assertFalse(any("dispatch" in argv and "--dry-run" not in argv for argv, _ in scripted.calls))
                self.assertTrue(any("archive" in argv for argv, _ in scripted.calls))

    def test_elapsed_setup_reduces_card_runtime_and_gate_dispatch_deadline(self) -> None:
        now = [0.0]
        scripted = ScriptedHermes()

        def runner(argv, **kwargs):
            if argv[2:4] == ["boards", "create"]:
                now[0] += 7
            elif "comment" in argv:
                now[0] += 3
            return scripted(argv, **kwargs)

        before = time.monotonic()
        result = self.adapter(runner, timeout_seconds=30, clock=lambda: now[0]).run(claim(), FakeControl())
        self.assertEqual(result.status, "succeeded")
        create_argv = next(argv for argv, _ in scripted.calls if "--idempotency-key" in argv)
        self.assertEqual(create_argv[create_argv.index("--max-runtime") + 1], "23")
        dispatch_env = next(env for argv, env in scripted.calls if "dispatch" in argv and "--dry-run" not in argv)
        deadline = float(dispatch_env["COMPASS_HERMES_LEASE_DEADLINE"])
        self.assertGreaterEqual(deadline, before + 20)
        self.assertLessEqual(deadline, time.monotonic() + 20)

    def test_evaluation_profile_is_explicitly_configurable(self) -> None:
        adapter = self.adapter(
            ScriptedHermes(), model="gpt-public", reasoning="medium",
            evaluation_model="gpt-evaluator", evaluation_provider="provider-test",
            evaluation_reasoning="high",
        )
        body = adapter._card_body("task-1", 2, "linkedin_evaluate")

        self.assertEqual(adapter.evaluation_profile.model, "gpt-evaluator")
        self.assertEqual(adapter.evaluation_profile.provider, "provider-test")
        self.assertEqual(adapter.evaluation_profile.reasoning, "high")
        self.assertIn("one tool-free configured evaluation-model call", body)
        self.assertNotIn("strategy and CV sections", body)

    def test_evaluation_can_deliberately_reuse_complete_general_profile(self) -> None:
        adapter = self.adapter(
            ScriptedHermes(),
            model="model-general",
            provider="provider-test",
            reasoning="medium",
        )

        self.assertTrue(adapter.evaluation_configured)
        self.assertEqual(adapter.evaluation_configuration_source, "general")
        self.assertEqual(adapter.evaluation_profile.model, "model-general")
        self.assertEqual(adapter.evaluation_profile.provider, "provider-test")
        self.assertEqual(adapter.evaluation_profile.reasoning, "medium")

    def test_partial_evaluation_profile_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "model, provider, and reasoning together"):
            self.adapter(
                ScriptedHermes(),
                evaluation_model="model-evaluator",
                evaluation_provider="provider-test",
            )

    def test_unconfigured_evaluation_fails_before_native_or_model_work(self) -> None:
        native = ScriptedHermes()
        adapter = self.adapter(native)
        task_claim = claim()
        task_claim.task["kind"] = "linkedin_evaluate"

        result = adapter.run(task_claim, FakeControl())

        self.assertEqual(result.status, "failed")
        self.assertFalse(result.retryable)
        self.assertTrue(result.cleanup_confirmed)
        self.assertIn("explicit model, provider, and reasoning", result.summary)
        self.assertFalse(adapter.evaluation_configured)
        self.assertEqual(native.calls, [])

    def test_search_reasoning_stays_out_of_cards(self) -> None:
        for kind, expected in (("search", "low"),):
            with self.subTest(kind=kind):
                scripted = ScriptedHermes()
                adapter = self.adapter(scripted, model="same-model", reasoning="low")
                task_claim = claim()
                task_claim.task["kind"] = kind
                task_claim.task["payload"]["reasoning"] = "ultra"
                self.assertEqual(adapter.run(task_claim, FakeControl()).status, "succeeded")
                for argv, env in scripted.calls:
                    self.assertNotIn("--reasoning", argv)
                    if "dispatch" in argv and "--dry-run" not in argv:
                        self.assertEqual(env["COMPASS_HERMES_REASONING"], expected)
                    else:
                        self.assertNotIn("COMPASS_HERMES_REASONING", env)

    def test_completed_deterministic_collection_limits_search_card_to_public_web(self) -> None:
        scripted = ScriptedHermes()
        task_claim = claim()
        task_claim.task["checkpoint"] = {
            "linkedin_collection": {"attempt": 2, "collected": True, "coverage": "partial"},
            "public_search_remaining_budget": {
                "remaining": {
                    "maxPages": 7,
                    "maxDetailFetches": 26,
                    "maxDurationSeconds": 1099,
                }
            },
        }

        result = self.adapter(scripted).run(task_claim, FakeControl())

        self.assertEqual(result.status, "succeeded")
        create_argv = next(
            argv for argv, _ in scripted.calls if "--idempotency-key" in argv
        )
        body = create_argv[create_argv.index("--body") + 1]
        self.assertIn("public-web source work only", body)
        self.assertIn("Do not browse, search, fetch or ingest LinkedIn again", body)
        self.assertIn("coverage, gaps, errors and stop reasons", body)
        self.assertIn("authoritative over the original budget", body)
        self.assertIn('"maxDurationSeconds":1099', body)
        self.assertIn("full wall-clock allowance", body)
        self.assertIn("earlier of 80% of that duration or 120 seconds remaining", body)
        self.assertIn("finish at most the currently started verify-to-save pair", body)
        self.assertIn("do not chase the maximum job count", body)

    def test_stale_collection_checkpoint_does_not_limit_current_attempt(self) -> None:
        task_claim = claim(attempt=3)
        task_claim.task["checkpoint"] = {
            "linkedin_collection": {"attempt": 2, "collected": True}
        }

        self.assertFalse(
            HermesKanbanAdapter._linkedin_collection_completed(task_claim.task, 3)
        )

    def test_clean_blocked_linkedin_stage_limits_current_card_to_public_only(self) -> None:
        scripted = ScriptedHermes()
        task_claim = claim()
        task_claim.task["checkpoint"] = {
            "linkedin_collection": {"attempt": 2, "collected": False, "stage_finished": True},
            "public_search_remaining_budget": {"remaining": {"maxPages": 9, "maxDetailFetches": 30, "maxDurationSeconds": 270}},
        }
        self.assertEqual(self.adapter(scripted).run(task_claim, FakeControl()).status, "succeeded")
        create = next(argv for argv, _ in scripted.calls if "--idempotency-key" in argv)
        body = create[create.index("--body") + 1]
        self.assertIn("may be incomplete or blocked", body)
        self.assertIn("Do not browse, search, fetch or ingest LinkedIn again", body)
        self.assertIn('"maxDurationSeconds":270', body)
        self.assertIn("call kanban_complete immediately", body)
        self.assertFalse(HermesKanbanAdapter._linkedin_collection_completed(task_claim.task, 3))

    def test_shutdown_cleanup_attestation_requires_verified_native_termination(self) -> None:
        for terminated in (True, False, None):
            with self.subTest(terminated=terminated):
                class StoppingControl(FakeControl):
                    def report_progress(self, **kwargs: Any) -> bool:
                        self.cancelled = True
                        self.reason = "worker is shutting down"
                        return super().report_progress(**kwargs)

                class ReclaimHermes(ScriptedHermes):
                    shows = 0

                    def __call__(self, argv, **kwargs):
                        if "show" not in argv:
                            return super().__call__(argv, **kwargs)
                        card_id = argv[argv.index("show") + 1]
                        if card_id in self.archived:
                            state = {"task": {"id": card_id, "status": "archived",
                                              "assignee": self.assignee},
                                     "runs": []}
                            return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
                        self.shows += 1
                        metadata = {} if terminated is None else {
                            "prev_pid": 4217, "terminated": terminated,
                        }
                        state = {"task": {"id": "t_12345678", "assignee": self.assignee,
                                          "status": "running" if self.shows == 1 else "ready"},
                                 "runs": [{"metadata": metadata}]}
                        return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")

                native = ReclaimHermes()
                adapter = HermesKanbanAdapter(
                    "https://compass.example", hermes_bin=sys.executable,
                    source_env={"PATH": "/usr/bin"}, command_runner=native,
                )
                result = adapter.run(claim(), StoppingControl())
                self.assertIs(result.cleanup_confirmed, terminated is True)
                self.assertEqual(result.checkpoint["hermes"]["card_id"], "t_12345678")
                self.assertEqual(
                    any("archive" in argv for argv, _ in native.calls),
                    terminated is True,
                )
                self.assertEqual(
                    any("block" in argv for argv, _ in native.calls),
                    terminated is not True,
                )

    def test_cancel_reports_unverified_native_worker_termination(self) -> None:
        calls: list[list[str]] = []
        show_count = 0
        parked = False
        assignee = "compass-worker"

        def runner(
            argv: list[str],
            **kwargs: Any,
        ) -> subprocess.CompletedProcess[str]:
            nonlocal assignee, parked, show_count
            calls.append(list(argv))
            if "show" in argv:
                show_count += 1
                state = {
                    "task": {
                        "id": "t_12345678",
                        "status": (
                            "running" if show_count == 1
                            else "blocked" if parked
                            else "ready"
                        ),
                        "assignee": assignee,
                    },
                    "events": [],
                    "runs": [] if show_count == 1 else [{
                        "metadata": {
                            "prev_pid": 4217,
                            "host_local": True,
                            "termination_attempted": True,
                            "terminated": False,
                            "sigkill": True,
                        },
                    }],
                }
                return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
            if "reclaim" in argv:
                return subprocess.CompletedProcess(argv, 0, "ok\n", "")
            if "block" in argv:
                parked = True
                return subprocess.CompletedProcess(argv, 0, "ok\n", "")
            if "assign" in argv:
                assignee = argv[-1]
                return subprocess.CompletedProcess(argv, 0, "ok\n", "")
            raise AssertionError(f"Unexpected Hermes argv: {argv}")

        adapter = HermesKanbanAdapter(
            "https://compass.example",
            hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"},
            command_runner=runner,
        )
        issue = adapter._cancel_card("t_12345678", "lease lost")

        self.assertEqual(
            issue,
            "Hermes reclaim did not verify native worker termination",
        )
        self.assertTrue(any("reclaim" in argv for argv in calls))
        self.assertTrue(any("block" in argv for argv in calls))

    def test_ready_card_does_not_hide_an_unverified_prior_worker(self) -> None:
        for metadata in ({"prev_pid": 4217}, {"prev_pid": 4217, "terminated": False}):
            with self.subTest(metadata=metadata):
                parked = False
                assignee = "compass-worker"

                def runner(argv, **kwargs):
                    nonlocal assignee, parked
                    if "show" in argv:
                        state = {"task": {"id": "t_12345678",
                                          "status": "blocked" if parked else "ready",
                                          "assignee": assignee},
                                 "runs": [{"metadata": metadata}]}
                        return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
                    if "block" in argv:
                        parked = True
                        return subprocess.CompletedProcess(argv, 0, "ok", "")
                    if "assign" in argv:
                        assignee = argv[-1]
                        return subprocess.CompletedProcess(argv, 0, "ok", "")
                    raise AssertionError(argv)

                adapter = HermesKanbanAdapter(
                    "https://compass.example", hermes_bin=sys.executable,
                    source_env={"PATH": "/usr/bin"}, command_runner=runner,
                )
                self.assertEqual(adapter._cancel_card("t_12345678", "worker is shutting down"),
                                 "Hermes prior worker termination remains unverified")

    def test_review_with_unverified_worker_is_removed_from_review_lane(self) -> None:
        calls: list[list[str]] = []
        status = "review"
        runs = [{"worker_pid": 4217, "metadata": {}}]
        assignee = "compass-worker"

        def runner(argv, **kwargs):
            nonlocal assignee, status
            calls.append(list(argv))
            if "show" in argv:
                state = {
                    "task": {"id": "t_review", "status": status,
                             "assignee": assignee},
                    "runs": runs,
                    "events": [],
                }
                return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
            if "reopen-review" in argv:
                status = "ready"
                return subprocess.CompletedProcess(argv, 0, "ok", "")
            if "block" in argv:
                status = "blocked"
                runs.append({"worker_pid": None, "metadata": None})
                return subprocess.CompletedProcess(argv, 0, "ok", "")
            if "assign" in argv:
                assignee = argv[-1]
                return subprocess.CompletedProcess(argv, 0, "ok", "")
            raise AssertionError(argv)

        issue = self.adapter(runner)._cancel_card("t_review", "lease lost")

        self.assertEqual(issue, "Hermes prior worker termination remains unverified")
        self.assertEqual(status, "blocked")
        self.assertTrue(any("reopen-review" in argv for argv in calls))
        self.assertTrue(any("block" in argv and "needs_input" in argv for argv in calls))
        self.assertEqual(assignee, "compass-worker-staging")
        self.assertFalse(any("archive" in argv for argv in calls))

        repeated = self.adapter(runner)._cancel_card("t_review", "retry cleanup")
        self.assertEqual(repeated, "Hermes prior worker termination remains unverified")
        self.assertFalse(any("archive" in argv for argv in calls))

    def test_post_handoff_spawn_event_prevents_archival(self) -> None:
        calls: list[list[str]] = []
        assignee = "compass-worker"

        def runner(argv, **kwargs):
            nonlocal assignee
            calls.append(list(argv))
            if "show" in argv:
                state = {
                    "task": {"id": "t_fast", "status": "blocked",
                             "assignee": assignee},
                    "runs": [
                        {"worker_pid": None, "metadata": None},
                        {"worker_pid": None, "metadata": {
                            "prev_pid": 9999, "terminated": True,
                        }},
                    ],
                    "events": [
                        {"kind": "blocked", "run_id": 7, "payload": {"kind": "transient"}},
                        {"kind": "spawned", "run_id": None, "payload": {"pid": 4217}},
                        {"kind": "spawned", "run_id": 8, "payload": {"pid": 9999}},
                    ],
                }
                return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
            if "assign" in argv:
                assignee = argv[-1]
                return subprocess.CompletedProcess(argv, 0, "ok", "")
            raise AssertionError(argv)

        issue = self.adapter(runner)._cancel_card("t_fast", "attempt failed")

        self.assertEqual(issue, "Hermes prior worker termination remains unverified")
        self.assertFalse(any("archive" in argv for argv in calls))

    def test_future_promotable_unverified_card_is_reassigned_to_staging(self) -> None:
        for initial_status in ("todo", "scheduled"):
            with self.subTest(status=initial_status):
                assignee = "compass-worker"
                calls: list[list[str]] = []

                def runner(argv, **kwargs):
                    nonlocal assignee
                    calls.append(list(argv))
                    if "show" in argv:
                        state = {
                            "task": {"id": "t_waiting", "status": initial_status,
                                     "assignee": assignee},
                            "runs": [{"worker_pid": 4217, "metadata": {}}],
                            "events": [],
                        }
                        return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
                    if "assign" in argv:
                        assignee = argv[-1]
                        return subprocess.CompletedProcess(argv, 0, "ok", "")
                    raise AssertionError(argv)

                issue = self.adapter(runner)._cancel_card("t_waiting", "lease lost")

                self.assertEqual(issue, "Hermes prior worker termination remains unverified")
                self.assertEqual(assignee, "compass-worker-staging")
                self.assertFalse(any("archive" in argv for argv in calls))

    def test_cancel_archives_review_card_with_reason(self) -> None:
        calls: list[list[str]] = []
        archived = False

        def runner(
            argv: list[str],
            **kwargs: Any,
        ) -> subprocess.CompletedProcess[str]:
            nonlocal archived
            calls.append(list(argv))
            if "show" in argv:
                return subprocess.CompletedProcess(
                    argv,
                    0,
                    json.dumps({"task": {
                        "id": "t_review",
                        "status": "archived" if archived else "review",
                    }}),
                    "",
                )
            if "comment" in argv:
                return subprocess.CompletedProcess(argv, 0, "ok\n", "")
            if "archive" in argv:
                archived = True
                return subprocess.CompletedProcess(argv, 0, "ok\n", "")
            raise AssertionError(f"Unexpected Hermes argv: {argv}")

        adapter = HermesKanbanAdapter(
            "https://compass.example",
            hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"},
            command_runner=runner,
        )

        issue = adapter._cancel_card("t_review", "lease lost")

        self.assertIsNone(issue)
        comment_index = next(i for i, argv in enumerate(calls) if "comment" in argv)
        archive_index = next(i for i, argv in enumerate(calls) if "archive" in argv)
        self.assertLess(comment_index, archive_index)
        self.assertIn("Compass attempt retired: lease lost", calls[comment_index])


class HermesLaunchTest(unittest.TestCase):
    def test_native_candidate_gate_with_actual_processes(self) -> None:
        launcher = Path(__file__).resolve().parents[2] / "scripts/compass_worker/hermes_launch.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime_root = root / "runtime"
            (runtime_root / "hermes_cli").mkdir(parents=True)
            (runtime_root / "hermes_cli" / "main.py").write_text("# fixture runtime\n")
            (runtime_root / "cli.py").write_text("# fixture runtime\n")
            profile_home = root / "compass-worker"
            profile_home.mkdir()
            managed = root / "managed"
            managed.mkdir()
            marker = root / "model-started.json"
            real_cli = root / "hermes-fixture"
            real_cli.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                f"with open({str(marker)!r}, 'w') as output:\n"
                "    json.dump({'task': os.environ.get('HERMES_KANBAN_TASK'), "
                "'token_present': bool(os.environ.get('COMPASS_TASK_TOKEN')), "
                "'routing_clean': not any(k.startswith('COMPASS_HERMES_') for k in os.environ), "
                "'bin_override_cleared': 'HERMES_BIN' not in os.environ, "
                "'secrets_clean': not any(k in os.environ for k in "
                "['OWNER_MCP_TOKEN', 'HERMES_API_TOKEN', 'COMPASS_WORKER_TOKEN', "
                "'OP_SERVICE_ACCOUNT_TOKEN', 'BROWSER_USE_API_KEY', 'UNKNOWN_NATIVE_SECRET', 'PYTHONPATH']), "
                "'argv': sys.argv[1:]}, output)\n"
            )
            real_cli.chmod(0o700)
            env = {
                "PATH": os.defpath,
                "HERMES_BIN": str(launcher),
                "COMPASS_HERMES_REAL_BIN": str(real_cli),
                "COMPASS_HERMES_RUNTIME_ROOT": str(runtime_root),
                "COMPASS_HERMES_REASONING": "medium",
                "HERMES_HOME": str(profile_home),
                "HERMES_MANAGED_DIR": str(managed),
                "OWNER_MCP_TOKEN": "synthetic-root-app-token",
                "HERMES_API_TOKEN": "synthetic-root-app-token",
                "COMPASS_WORKER_TOKEN": "synthetic-worker-token",
                "OP_SERVICE_ACCOUNT_TOKEN": "synthetic-vault-token",
                "BROWSER_USE_API_KEY": "synthetic-browser-key",
                "UNKNOWN_NATIVE_SECRET": "synthetic-future-secret",
                "PYTHONPATH": "/untrusted-python-path",
                "COMPASS_HERMES_EXPECTED_CARD": "t_selected",
                "COMPASS_HERMES_EXPECTED_BOARD": "compass",
                "COMPASS_HERMES_EXPECTED_PROFILE": "compass-worker",
                "COMPASS_HERMES_LEASE_DEADLINE": str(time.monotonic() + 120),
                "COMPASS_TASK_ID": "app-task",
                "COMPASS_TASK_ATTEMPT": "2",
                "COMPASS_TASK_TOKEN": "test-only-capability",
                "HERMES_KANBAN_TASK": "t_selected",
                "HERMES_KANBAN_BOARD": "compass",
                "HERMES_PROFILE": "compass-worker",
                "HERMES_KANBAN_RUN_ID": "7",
                "HERMES_KANBAN_CLAIM_LOCK": "native-lock",
            }
            args = ["-p", "compass-worker", "--cli", "--accept-hooks", "-m", "gpt-configured",
                    "--provider", "provider-test",
                    "--toolsets", "browser,compass,web",
                    "chat", "-q", "work kanban task t_selected"]
            variants = [
                ({"COMPASS_HERMES_LEASE_DEADLINE": "0"}, args),
                ({"COMPASS_HERMES_LEASE_DEADLINE": "nan"}, args),
                ({"COMPASS_HERMES_LEASE_DEADLINE": ""}, args),
                ({"HERMES_KANBAN_TASK": "t_raced"}, [*args[:-1], "work kanban task t_raced"]),
                ({"HERMES_KANBAN_BOARD": "other"}, args),
                ({"HERMES_PROFILE": "other"}, args),
                ({"HERMES_KANBAN_RUN_ID": ""}, args),
                ({"HERMES_KANBAN_CLAIM_LOCK": ""}, args),
                ({"COMPASS_TASK_TOKEN": ""}, args),
                ({"COMPASS_HERMES_REAL_BIN": "relative-hermes"}, args),
                ({"COMPASS_HERMES_REAL_BIN": str(launcher)}, args),
                ({"COMPASS_HERMES_RUNTIME_ROOT": ""}, args),
                ({"COMPASS_HERMES_REASONING": "--unsafe"}, args),
                ({"COMPASS_HERMES_REASONING": "unknown"}, args),
                ({}, [*args[:-3], "--reasoning", "ultra", *args[-3:]]),
                ({"HERMES_HOME": ""}, args),
                ({}, [*args[:-1], "work kanban task t_raced"]),
                ({}, [*args[:4], "--skills", "unexpected-skill", *args[4:]]),
                ({}, [*args[:4], "-p", "other", *args[4:]]),
            ]
            for changes, candidate_args in variants:
                with self.subTest(changes=changes, candidate_args=candidate_args):
                    result = subprocess.run(
                        [str(launcher), *candidate_args], env={**env, **changes},
                        capture_output=True, text=True, timeout=5,
                    )
                    self.assertEqual(result.returncode, 78)
                    self.assertFalse(marker.exists(), "mismatched candidate reached model startup")
                    self.assertNotIn("test-only-capability", result.stdout + result.stderr)

            # The adapter's confirmed deadline can elapse while native dispatch
            # prepares a workspace. Even the correct card must then be refused.
            delayed_env = {**env, "COMPASS_HERMES_LEASE_DEADLINE": str(time.monotonic() + 0.03)}
            time.sleep(0.05)
            delayed = subprocess.run(
                [str(launcher), *args], env=delayed_env, capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(delayed.returncode, 78)
            self.assertFalse(marker.exists())

            result = subprocess.run(
                [str(launcher), *args], env=env, capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            started = json.loads(marker.read_text())
            self.assertEqual(started["task"], "t_selected")
            self.assertTrue(started["token_present"])
            self.assertTrue(started["routing_clean"])
            self.assertTrue(started["bin_override_cleared"])
            self.assertTrue(started["secrets_clean"])
            self.assertEqual(started["argv"], [*args[:-3], "--reasoning", "medium", *args[-3:]])
            marker.unlink()
            for forbidden in (runtime_root / ".env", profile_home / ".env",
                              profile_home / ".op.env", managed / ".env", managed / "config.yaml"):
                with self.subTest(forbidden=forbidden.name):
                    forbidden.write_text("UNKNOWN_NATIVE_SECRET=synthetic-file-secret\n")
                    refused = subprocess.run([str(launcher), *args], env=env, capture_output=True, text=True, timeout=5)
                    self.assertEqual(refused.returncode, 78)
                    self.assertFalse(marker.exists())
                    self.assertNotIn("synthetic-file-secret", refused.stdout + refused.stderr)
                    forbidden.unlink()


if __name__ == "__main__":
    unittest.main()
