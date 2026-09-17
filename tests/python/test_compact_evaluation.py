from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from scripts.compass_worker.compact_evaluation import (
    ANALYSIS_INSTRUCTIONS,
    CompactEvaluationFailure,
    CompactEvaluationRunner,
    INSTRUCTIONS,
    build_compact_prompt,
    render_job_analysis,
    validate_compact_output,
    validate_job_analysis,
)
from scripts.compass_worker.client import TaskClaim
from scripts.compass_worker.hermes import HermesKanbanAdapter


def context() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "candidate": {
            "id": "candidate-1",
            "targetRoles": ["technical program manager"],
            "workingLanguages": ["English"],
            "factualProfile": {"sourceCvVariantId": "11111111-1111-4111-8111-111111111111", "contentMd": "Led safety-critical software programs across engineering teams."},
            "cvVariants": [{"id": "11111111-1111-4111-8111-111111111111", "name": "TPM", "purpose": "Technical programs"}],
        },
        "effectivePolicy": {
            "schemaVersion": 1,
            "minimumFitScore": 70,
            "roles": {"targets": ["technical program manager"]},
            "languages": {"accepted": ["English"]},
            "office": {"workModes": ["onsite", "hybrid"], "locations": [{"city": "Brno", "countryCode": "CZ", "radiusKm": 50}]},
            "remote": {"enabled": True, "eligibleCountryCodes": ["CZ"], "includeWorldwide": False, "includeUnspecified": False},
            "exclusions": {"companies": [], "keywords": ["sales"]},
            "tailoring": {"suggestCv": True},
        },
        "policyHash": "a" * 64,
        "snapshot": {
            "id": "22222222-2222-4222-8222-222222222222",
            "title": "Technical Program Manager",
            "company": "Example",
            "canonicalUrl": "https://www.linkedin.com/jobs/view/123456789",
            "location": "Holon, Israel",
            "workModeText": "On-site",
            "snapshotEvidence": {
                "description": "This on-site role is based in Holon, Israel and requires English. Lead software programs."
            },
        },
    }


def decision(*, status: str = "rejected", location_eligible: bool = False) -> dict[str, object]:
    return {
        "status": status,
        "reason": "The on-site role is outside the configured Brno office radius.",
        "fit_score": 82,
        "policy_evidence": {
            "location_eligible": location_eligible,
            "language_eligible": True,
            "role_eligible": True,
            "exclusions_clear": True,
            "explanation": "Stored location and work-mode evidence place this role in Holon, Israel.",
        },
        "source_facts": {
            "work_mode": "onsite",
            "work_mode_quote": "on-site role",
            "location": {
                "raw": "Holon, Israel",
                "city": "Holon",
                "country_code": "IL",
                "evidence_quote": "based in Holon, Israel",
            },
            "remote_eligibility": {
                "scope": "unspecified",
                "eligible_country_codes": [],
                "evidence_quote": None,
            },
            "language_requirements": [{"language": "English", "required": True, "evidence_quote": "requires English"}],
        },
    }


def rich_analysis() -> tuple[dict[str, object], list[dict[str, object]]]:
    analysis = {
        "summary": "The role leads software programs across engineering teams. The candidate's supplied profile supports closely related delivery work.",
        "role_fit": "The vacancy explicitly centers on leading software programs. That work matches the configured technical program target.",
        "candidate_fit": "The candidate's factual profile says she led safety-critical software programs. This directly supports the vacancy's cross-team delivery focus.",
        "requirements_and_gaps": "The stored posting requires English, which the supplied profile lists as a working language. It does not establish additional mandatory requirements.",
        "practicalities": "The posting describes an on-site role in Holon, Israel. This example assumes that location has passed the configured policy gate.",
        "cv_recommendation": "Use the supplied TPM variant because its stated purpose is technical programs. No unsupported CV claims should be added.",
        "questions": ["What delivery scope and decision authority would this role own?"],
    }
    factors = [
        {
            "factor": "Technical program delivery",
            "weight": 28,
            "direction": "+",
            "note": "The vacancy asks for leadership of software programs across engineering teams.",
        },
        {
            "factor": "Relevant candidate evidence",
            "weight": 24,
            "direction": "+",
            "note": "The candidate's factual profile records leadership of safety-critical software programs.",
        },
    ]
    return analysis, factors


def promoted_decision() -> dict[str, object]:
    promoted = decision(status="promoted", location_eligible=True)
    promoted["job_analysis"], promoted["fit_factors"] = rich_analysis()
    return promoted


class Control:
    def __init__(self):
        self.cancelled = False
        self.reason = None
        self.lease_deadline = time.monotonic() + 120
        self.progress = []

    def report_progress(self, **kwargs):
        self.progress.append(kwargs)
        return True


class CompactEvaluationValidationTest(unittest.TestCase):
    def test_prompt_contains_only_compact_context_and_full_description(self) -> None:
        prompt = build_compact_prompt(context())
        self.assertIn("snapshotEvidence", prompt)
        self.assertIn("requires English", prompt)
        self.assertIn("Led safety-critical software programs", prompt)
        self.assertNotIn("strategy", prompt)

    def test_prompt_contract_covers_live_quality_failure_classes_generally(self) -> None:
        contract = " ".join(INSTRUCTIONS.split())
        self.assertIn("every snapshotEvidence field", contract)
        self.assertIn("availability, application-state, header, and applicant metadata", contract)
        self.assertIn("equally direct, current stored evidence", contract)
        self.assertIn("country-specific requirement to be based or resident there", contract)
        self.assertIn("Do not expand it to other configured countries", contract)
        self.assertIn("narrower country restriction and broader regional wording", contract)
        self.assertIn("essential work, primary responsibilities", contract)
        self.assertIn("transferable project or program skills", contract)
        self.assertIn("optional desirable technical qualification", contract)
        self.assertIn("sparse or summarized posting", contract)
        self.assertIn("lower fit_score for", contract)
        self.assertIn("effectivePolicy.roles.targets before comparing the candidate", contract)
        self.assertIn("principal deliverables, subject-matter domain, decision authority", contract)
        self.assertIn("Do not borrow a technical domain from the candidate's background", contract)
        self.assertIn("generic product launches, supply-chain changes, business-process improvements", contract)
        self.assertIn("Scheduling meetings, taking minutes, routing requirements, chasing dates", contract)
        self.assertIn("do not by themselves establish a configured program or project role", contract)
        self.assertIn("without adding a seniority, years-of-experience, budget-authority", contract)
        self.assertIn("Substantive coordination of technical delivery", contract)
        self.assertIn("not a mandatory checklist", contract)
        self.assertIn("duty-based tests, not title or industry exclusions", contract)
        self.assertIn("a coordinator title or a consumer, supply-chain, or other industry role can qualify", contract)
        self.assertNotIn("Jobgether", contract)
        self.assertNotIn("Randstad", contract)
        self.assertNotIn("Luxoft", contract)
        self.assertNotIn("Kenvue", contract)
        self.assertNotIn("Bulovka", contract)
        self.assertNotIn("DHL", contract)
        analysis_contract = " ".join(ANALYSIS_INSTRUCTIONS.split())
        self.assertIn("at least two useful positive factors", analysis_contract)
        self.assertIn("do not invent a concern to fill a quota", analysis_contract)
        self.assertIn("concrete 2-4 sentence paragraph", analysis_contract)

    def test_actual_israel_onsite_failure_cannot_be_promoted_with_failed_gate(self) -> None:
        invalid = decision(status="promoted", location_eligible=False)
        with self.assertRaisesRegex(ValueError, "every policy gate"):
            validate_compact_output(invalid, context())

    def test_recommended_cv_still_requires_an_exact_supplied_id(self) -> None:
        invalid = promoted_decision()
        invalid["recommended_cv_variant_id"] = "33333333-3333-4333-8333-333333333333"
        with self.assertRaisesRegex(ValueError, "not supplied in context"):
            validate_compact_output(invalid, context())

    def test_trusted_code_builds_promoted_job_from_snapshot_identity(self) -> None:
        promoted = promoted_decision()
        promoted["recommended_cv_variant_id"] = "11111111-1111-4111-8111-111111111111"
        validated = validate_compact_output(promoted, context())
        completion = HermesKanbanAdapter._compact_evaluation_completion(
            context(), validated, "t_audit"
        )
        job = completion["job"]
        self.assertEqual(job["title"], "Technical Program Manager")
        self.assertEqual(job["company"], "Example")
        self.assertEqual(job["description_md"], context()["snapshot"]["snapshotEvidence"]["description"])
        self.assertEqual(job["source_facts"], completion["evaluation"]["source_facts"])
        self.assertEqual(job["fit_factors"], promoted["fit_factors"])
        self.assertIn("## Why it fits", job["fit_analysis_md"])
        self.assertIn("## Watch out: requirements and gaps", job["fit_analysis_md"])
        self.assertIn("## CV recommendation", job["fit_analysis_md"])
        self.assertIn("## Next steps", job["fit_analysis_md"])
        self.assertNotIn("job_analysis", completion["evaluation"])
        self.assertEqual(completion["execution_ref"], "t_audit")

    def test_promoted_output_requires_complete_valid_rich_analysis(self) -> None:
        missing = decision(status="promoted", location_eligible=True)
        with self.assertRaisesRegex(ValueError, "rich job analysis"):
            validate_compact_output(missing, context())

        cases = []
        duplicate = promoted_decision()
        duplicate["fit_factors"][1]["factor"] = "  TECHNICAL  PROGRAM DELIVERY "
        cases.append((duplicate, "unique"))
        wrong_sign = promoted_decision()
        wrong_sign["fit_factors"][0]["weight"] = -28
        cases.append((wrong_sign, "weight"))
        oversized = promoted_decision()
        oversized["job_analysis"]["summary"] = "x" * 1_101
        cases.append((oversized, "prose"))
        malformed = promoted_decision()
        malformed["job_analysis"]["questions"] = ["question"] * 6
        cases.append((malformed, "questions"))
        non_finite = promoted_decision()
        non_finite["fit_factors"][0]["weight"] = float("nan")
        cases.append((non_finite, "weight"))
        too_few_positives = promoted_decision()
        too_few_positives["fit_factors"] = too_few_positives["fit_factors"][:1]
        cases.append((too_few_positives, "at least two positive"))

        for invalid, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    validate_compact_output(invalid, context())

    def test_pure_renderer_escapes_model_markdown_and_does_not_require_a_concern(self) -> None:
        analysis, factors = rich_analysis()
        analysis["summary"] = "## Injected heading\n```unsafe``` is source text, not trusted formatting."
        validated_analysis, validated_factors = validate_job_analysis(analysis, factors)
        rendered = render_job_analysis(validated_analysis, validated_factors)

        self.assertIn("# Fit analysis", rendered)
        self.assertNotIn("\n## Injected heading", rendered)
        self.assertNotIn("```unsafe```", rendered)
        self.assertIn(r"\#\# Injected heading \`\`\`unsafe\`\`\`", rendered)
        self.assertIn("## Watch out: requirements and gaps", rendered)
        self.assertEqual([factor["direction"] for factor in factors], ["+", "+"])

    def test_unhashable_remote_country_item_is_a_bounded_validation_error(self) -> None:
        invalid = decision()
        invalid["source_facts"]["remote_eligibility"]["eligible_country_codes"] = [
            {"country": "CZ"}
        ]
        with self.assertRaisesRegex(ValueError, "remote eligibility evidence"):
            validate_compact_output(invalid, context())


class CompactEvaluationChildTest(unittest.TestCase):
    def test_runner_requires_operator_selected_runtime_settings(self) -> None:
        with self.assertRaisesRegex(TypeError, "model.*provider.*reasoning_effort"):
            CompactEvaluationRunner()

    def test_native_child_makes_one_tool_free_luna_low_call(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "hermes_cli").mkdir()
            (root / "hermes_cli" / "__init__.py").write_text("", encoding="utf-8")
            (root / "hermes_cli" / "runtime_provider.py").write_text(
                "def resolve_runtime_provider(*, requested, target_model):\n"
                "    assert requested == 'provider-test' and target_model == 'model-test'\n"
                "    return {'provider': requested, 'api_key': 'private-fixture', 'base_url': 'https://example.invalid', 'api_mode': 'responses'}\n",
                encoding="utf-8",
            )
            response = json.dumps(decision())
            (root / "run_agent.py").write_text(
                "class AIAgent:\n"
                "    def __init__(self, **kwargs):\n"
                "        assert kwargs['model'] == 'model-test'\n"
                "        assert kwargs['provider'] == 'provider-test'\n"
                "        assert kwargs['enabled_toolsets'] == []\n"
                "        assert kwargs['max_iterations'] == 1\n"
                "        assert kwargs['reasoning_config'] == {'effort': 'medium'}\n"
                "        assert kwargs['session_db'] is None and kwargs['fallback_model'] is None\n"
                "        self.tools=[]; self._session_db=None; self._fallback_chain=[]; self._api_call_count=0\n"
                "        self.session_input_tokens=500; self.session_cache_read_tokens=100\n"
                "        self.session_output_tokens=80; self.session_reasoning_tokens=20\n"
                "    def run_conversation(self, prompt):\n"
                "        assert 'Holon, Israel' in prompt\n"
                "        self._api_call_count=1\n"
                f"        return {{'final_response': {response!r}}}\n"
                "    def close(self): pass\n",
                encoding="utf-8",
            )
            runner = CompactEvaluationRunner(
                model="model-test",
                provider="provider-test",
                reasoning_effort="medium",
                source_env={"PATH": "/usr/bin", "COMPASS_HERMES_RUNTIME_ROOT": str(root)},
                python_bin=sys.executable,
            )
            result = runner.run(context(), Control(), timeout_seconds=30)

        self.assertEqual(result["modelCalls"], 1)
        self.assertEqual(result["toolCalls"], 0)
        self.assertEqual(result["model"], "model-test")
        self.assertEqual(result["reasoningEffort"], "medium")
        self.assertEqual(result["usage"]["uncachedInputTokens"], 500)
        self.assertEqual(result["usage"]["cacheReadTokens"], 100)

    def test_invalid_output_retains_actual_call_usage_and_sanitized_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "hermes_cli").mkdir()
            (root / "hermes_cli" / "__init__.py").write_text("", encoding="utf-8")
            (root / "hermes_cli" / "runtime_provider.py").write_text(
                "def resolve_runtime_provider(*, requested, target_model):\n"
                "    return {'provider': requested, 'api_key': 'private-fixture', 'base_url': 'https://example.invalid', 'api_mode': 'responses'}\n",
                encoding="utf-8",
            )
            invalid = decision()
            invalid["source_facts"]["remote_eligibility"]["eligible_country_codes"] = [
                {"country": "CZ"}
            ]
            response = json.dumps(invalid)
            (root / "run_agent.py").write_text(
                "class AIAgent:\n"
                "    def __init__(self, **kwargs):\n"
                "        self.tools=[]; self._session_db=None; self._fallback_chain=[]; self._api_call_count=0\n"
                "        self.session_input_tokens=500; self.session_cache_read_tokens=100\n"
                "        self.session_output_tokens=80; self.session_reasoning_tokens=20\n"
                "    def run_conversation(self, prompt):\n"
                "        self._api_call_count=1\n"
                f"        return {{'final_response': {response!r}}}\n"
                "    def close(self): pass\n",
                encoding="utf-8",
            )
            runner = CompactEvaluationRunner(
                model="model-test",
                provider="provider-test",
                reasoning_effort="medium",
                source_env={"PATH": "/usr/bin", "COMPASS_HERMES_RUNTIME_ROOT": str(root)},
                python_bin=sys.executable,
            )
            with self.assertRaises(CompactEvaluationFailure) as raised:
                runner.run(context(), Control(), timeout_seconds=30)

        self.assertEqual(raised.exception.stage, "invalid_output")
        self.assertEqual(raised.exception.metrics["validationCode"], "invalid_remote_evidence")
        self.assertEqual(raised.exception.metrics["modelCalls"], 1)
        self.assertEqual(raised.exception.metrics["usage"]["inputTokens"], 600)


class _FixedEvaluationRunner:
    calls = 0

    def run(self, packet, control, *, timeout_seconds):
        self.calls += 1
        return {
            "decision": validate_compact_output(decision(), packet),
            "provider": "provider-test",
            "model": "model-test",
            "reasoningEffort": "medium",
            "modelAttempts": 1,
            "modelCalls": 1,
            "toolCalls": 0,
            "wallTimeSeconds": 0.4,
            "usage": {"inputTokens": 600, "uncachedInputTokens": 500, "cacheReadTokens": 100, "outputTokens": 80, "reasoningTokens": 20},
        }


class _FixedMcp:
    def __init__(self):
        self.calls = []

    def call(self, name, **arguments):
        self.calls.append((name, arguments))
        if name == "get_task_context":
            return {"evaluationContext": context(), "task": {}, "serverNowUtc": "2026-09-15T00:00:00Z"}
        if name == "complete_linkedin_evaluation":
            return {"outcome": "completed", "state": "rejected", "job_id": None}
        raise AssertionError(name)


class _CompactHermes:
    def __init__(self, *, status="blocked", assignee="compass-worker-staging"):
        self.calls = []
        self.metadata = None
        self.status = status
        self.assignee = assignee

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        if argv[2:4] == ["boards", "create"]:
            return subprocess.CompletedProcess(argv, 0, "ok", "")
        if "create" in argv and "--idempotency-key" in argv:
            return subprocess.CompletedProcess(argv, 0, json.dumps({"id": "t_eval", "status": self.status, "assignee": self.assignee}), "")
        if "assign" in argv:
            self.assignee = argv[-1]
            return subprocess.CompletedProcess(argv, 0, "ok", "")
        if "comment" in argv:
            return subprocess.CompletedProcess(argv, 0, "ok", "")
        if "complete" in argv:
            self.metadata = json.loads(argv[argv.index("--metadata") + 1])
            self.status = "done"
            return subprocess.CompletedProcess(argv, 0, "Completed", "")
        if "archive" in argv:
            self.status = "archived"
            return subprocess.CompletedProcess(argv, 0, "Archived", "")
        if "show" in argv:
            state = {
                "task": {"id": "t_eval", "status": self.status, "assignee": self.assignee, "result": None},
                "latest_summary": "LinkedIn evaluation rejected with one model-test call",
                "runs": [{"metadata": self.metadata}],
                "events": [],
            }
            return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
        raise AssertionError(argv)


class CompactEvaluationAdapterTest(unittest.TestCase):
    def test_adapter_persists_before_code_completes_card_without_dispatch(self) -> None:
        native = _CompactHermes()
        model = _FixedEvaluationRunner()
        mcp = _FixedMcp()
        adapter = HermesKanbanAdapter(
            "https://compass.example",
            hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"},
            command_runner=native,
            evaluation_runner=model,
            task_mcp_factory=lambda *_args, **_kwargs: mcp,
            sleeper=lambda _seconds: None,
        )
        claim = TaskClaim(
            task={"id": "33333333-3333-4333-8333-333333333333", "kind": "linkedin_evaluate", "executor": "hermes", "attemptCount": 1, "payload": {}, "checkpoint": {}},
            claim_token="attempt-token",
            lease_expires_at=None,
            heartbeat_interval_seconds=30,
        )
        control = Control()
        result = adapter.run(claim, control)

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(model.calls, 1)
        self.assertEqual([name for name, _ in mcp.calls], ["get_task_context", "complete_linkedin_evaluation"])
        completion = mcp.calls[1][1]
        self.assertEqual(completion["evaluation"]["source_facts"]["location"]["country_code"], "IL")
        self.assertEqual(completion["execution_ref"], "t_eval")
        self.assertFalse(any("dispatch" in argv for argv in native.calls))
        self.assertFalse(any("unblock" in argv for argv in native.calls))
        self.assertFalse(any("assign" in argv for argv in native.calls))
        self.assertFalse(any("comment" in argv for argv in native.calls))
        self.assertTrue(any("complete" in argv for argv in native.calls))
        self.assertEqual(result.result["evaluation_runtime"]["modelCalls"], 1)
        self.assertEqual(result.result["evaluation_runtime"]["toolCalls"], 0)
        self.assertEqual(result.checkpoint["compact_evaluation_attempts"]["1"]["stage"], "persisted")
        self.assertEqual(result.checkpoint["compact_evaluation_attempts"]["1"]["usage"]["inputTokens"], 600)
        self.assertTrue(any(item.get("external_ref") == "t_eval" for item in control.progress))
        create = next(argv for argv in native.calls if "--idempotency-key" in argv)
        self.assertEqual(create[create.index("--assignee") + 1], "compass-worker-staging")
        self.assertEqual(create[create.index("--initial-status") + 1], "blocked")
        body = create[create.index("--body") + 1]
        self.assertIn("blocked native card ID is the durable Compass execution reference", body)
        self.assertNotIn("Compass execution_ref:", body)
        self.assertNotIn("Use scoped Compass MCP", body)

    def test_idempotent_prechange_compact_card_is_reassigned_before_evaluation(self) -> None:
        native = _CompactHermes(assignee="compass-worker")
        model = _FixedEvaluationRunner()
        claim = TaskClaim(
            task={"id": "33333333-3333-4333-8333-333333333333",
                  "kind": "linkedin_evaluate", "executor": "hermes",
                  "attemptCount": 1, "payload": {}, "checkpoint": {}},
            claim_token="attempt-token", lease_expires_at=None,
            heartbeat_interval_seconds=30,
        )
        result = HermesKanbanAdapter(
            "https://compass.example", hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"}, command_runner=native,
            evaluation_runner=model,
            task_mcp_factory=lambda *_args, **_kwargs: _FixedMcp(),
            sleeper=lambda _seconds: None,
        ).run(claim, Control())

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(model.calls, 1)
        assign = next(argv for argv in native.calls if "assign" in argv)
        self.assertEqual(assign[-1], "compass-worker-staging")
        self.assertFalse(any("dispatch" in argv for argv in native.calls))

    def test_idempotent_compact_card_in_native_lane_is_archived_without_evaluation(self) -> None:
        native = _CompactHermes(status="ready", assignee="compass-worker")
        model = _FixedEvaluationRunner()
        claim = TaskClaim(
            task={"id": "33333333-3333-4333-8333-333333333333",
                  "kind": "linkedin_evaluate", "executor": "hermes",
                  "attemptCount": 1, "payload": {}, "checkpoint": {}},
            claim_token="attempt-token", lease_expires_at=None,
            heartbeat_interval_seconds=30,
        )
        result = HermesKanbanAdapter(
            "https://compass.example", hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"}, command_runner=native,
            evaluation_runner=model,
            task_mcp_factory=lambda *_args, **_kwargs: _FixedMcp(),
            sleeper=lambda _seconds: None,
        ).run(claim, Control())

        self.assertEqual(result.status, "failed")
        self.assertTrue(result.cleanup_confirmed)
        self.assertEqual(model.calls, 0)
        self.assertTrue(any("archive" in argv for argv in native.calls))
        self.assertFalse(any("dispatch" in argv for argv in native.calls))

    def test_retry_after_app_persistence_finalizes_card_without_another_model_call(self) -> None:
        native = _CompactHermes()
        model = _FixedEvaluationRunner()
        mcp = _FixedMcp()
        runtime = {
            "provider": "provider-test", "model": "model-test", "reasoningEffort": "medium",
            "modelAttempts": 1, "modelCalls": 1, "toolCalls": 0, "wallTimeSeconds": 1.2,
            "usage": {"inputTokens": 600, "uncachedInputTokens": 500, "cacheReadTokens": 100, "outputTokens": 80, "reasoningTokens": 20},
        }
        claim = TaskClaim(
            task={
                "id": "33333333-3333-4333-8333-333333333333", "kind": "linkedin_evaluate",
                "executor": "hermes", "attemptCount": 2, "payload": {},
                "checkpoint": {"compact_evaluation": {"persisted": {"outcome": "completed", "state": "needs_review", "job_id": None}, "runtime": runtime, "status": "needs_review"}},
            },
            claim_token="attempt-token", lease_expires_at=None, heartbeat_interval_seconds=30,
        )
        result = HermesKanbanAdapter(
            "https://compass.example", hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"}, command_runner=native,
            evaluation_runner=model, task_mcp_factory=lambda *_args, **_kwargs: mcp,
            sleeper=lambda _seconds: None,
        ).run(claim, Control())

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(model.calls, 0)
        self.assertEqual(mcp.calls, [])
        self.assertEqual(result.checkpoint["compact_evaluation_attempts"]["2"]["stage"], "reused_persisted")
        self.assertEqual(result.checkpoint["compact_evaluation_attempts"]["2"]["modelCalls"], 0)
        complete = next(argv for argv in native.calls if "complete" in argv)
        self.assertTrue(any("needs_review" in argument for argument in complete))

    def test_failed_retry_adds_one_idempotent_attempt_entry_without_losing_prior_usage(self) -> None:
        class FailingRunner:
            def run(self, *_args, **_kwargs):
                raise CompactEvaluationFailure("invalid_output", {
                    "provider": "provider-test", "model": "model-test",
                    "reasoningEffort": "medium", "modelAttempts": 1, "modelCalls": 1,
                    "toolCalls": 0, "wallTimeSeconds": 0.7,
                    "validationCode": "invalid_remote_evidence",
                    "usage": {"inputTokens": 700, "uncachedInputTokens": 600,
                              "cacheReadTokens": 100, "outputTokens": 90,
                              "reasoningTokens": 25},
                })

        prior = {
            "compact_evaluation_attempts": {
                "1": {"stage": "invalid_output", "provider": "provider-test",
                      "model": "model-test", "reasoningEffort": "medium",
                      "modelAttempts": 1, "modelCalls": 1, "toolCalls": 0,
                      "usage": {"inputTokens": 600, "outputTokens": 80}}
            }
        }
        claim = TaskClaim(
            task={"id": "33333333-3333-4333-8333-333333333333",
                  "kind": "linkedin_evaluate", "executor": "hermes", "attemptCount": 2,
                  "payload": {}, "checkpoint": prior},
            claim_token="attempt-token", lease_expires_at=None,
            heartbeat_interval_seconds=30,
        )
        native = _CompactHermes()
        adapter = HermesKanbanAdapter(
            "https://compass.example", hermes_bin=sys.executable,
            source_env={"PATH": "/usr/bin"}, command_runner=native,
            evaluation_runner=FailingRunner(), task_mcp_factory=lambda *_args, **_kwargs: _FixedMcp(),
            sleeper=lambda _seconds: None,
        )

        first = adapter.run(claim, Control())
        claim.task["checkpoint"] = first.checkpoint
        second = adapter.run(claim, Control())

        self.assertEqual(first.status, "failed")
        self.assertTrue(first.cleanup_confirmed)
        self.assertTrue(any("archive" in argv for argv in native.calls))
        self.assertFalse(any("assign" in argv or "dispatch" in argv for argv in native.calls))
        self.assertEqual(set(first.checkpoint["compact_evaluation_attempts"]), {"1", "2"})
        self.assertEqual(second.checkpoint["compact_evaluation_attempts"], first.checkpoint["compact_evaluation_attempts"])
        self.assertEqual(first.checkpoint["compact_evaluation_attempts"]["1"]["usage"]["inputTokens"], 600)
        self.assertEqual(first.checkpoint["compact_evaluation_attempts"]["2"]["validationCode"], "invalid_remote_evidence")


if __name__ == "__main__":
    unittest.main()
