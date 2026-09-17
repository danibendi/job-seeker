from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.compass_worker.evaluation import (
    CodexBatchResult,
    CodexEvaluationRunner,
    ModelEffortProfile,
    build_evaluation_prompt,
    load_corpus,
    run_benchmark,
    validate_model_output,
)


def _corpus() -> dict[str, object]:
    return {
        "schema_version": 1,
        "policy": {
            "minimumFitScore": 70,
            "workModes": ["remote", "hybrid"],
            "excludedKeywords": ["sales"],
        },
        "cases": [
            {
                "id": "eligible",
                "snapshot": {
                    "title": "Technical Program Manager",
                    "company": "Example",
                    "location": "Remote, EU",
                    "description": "Lead cross-team software delivery in English.",
                },
                "reference": {
                    "status": "promoted",
                    "fit_score_min": 70,
                    "policy_evidence": {
                        "location_eligible": True,
                        "language_eligible": True,
                        "role_eligible": True,
                        "exclusions_clear": True,
                    },
                },
            },
            {
                "id": "excluded",
                "snapshot": {
                    "title": "Sales Program Manager",
                    "company": "Example",
                    "location": "Remote, EU",
                    "description": "Own enterprise sales targets.",
                },
                "reference": {
                    "status": "rejected",
                    "fit_score_max": 69,
                    "policy_evidence": {"exclusions_clear": False},
                },
            },
        ],
    }


def _decision(case_id: str, status: str) -> dict[str, object]:
    promoted = status == "promoted"
    return {
        "case_id": case_id,
        "status": status,
        "reason": "The complete description provides enough policy evidence.",
        "fit_score": 82 if promoted else 20,
        "policy_evidence": {
            "location_eligible": True,
            "language_eligible": True,
            "role_eligible": True,
            "exclusions_clear": True if promoted else False,
            "explanation": "The stored title, location and full description support this decision.",
        },
    }


class EvaluationCorpusTest(unittest.TestCase):
    def test_corpus_prompt_and_output_require_full_fixed_case_set(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "corpus.json"
            path.write_text(json.dumps(_corpus()), encoding="utf-8")
            corpus = load_corpus(path)

        prompt = build_evaluation_prompt(corpus["policy"], corpus["cases"])
        self.assertIn("Do not call tools", prompt)
        self.assertIn("complete title, company, location and description", prompt)
        self.assertIn("Do not use title-only or keyword-only role filtering", prompt)
        decisions = [
            _decision("eligible", "promoted"),
            _decision("excluded", "rejected"),
        ]
        ordered = validate_model_output(
            {"decisions": list(reversed(decisions))}, ["eligible", "excluded"]
        )
        self.assertEqual([item["case_id"] for item in ordered], ["eligible", "excluded"])
        with self.assertRaisesRegex(ValueError, "every requested case"):
            validate_model_output({"decisions": decisions[:1]}, ["eligible", "excluded"])

    def test_profile_rejects_unknown_reasoning_and_provider_without_model(self) -> None:
        with self.assertRaisesRegex(ValueError, "Reasoning effort"):
            ModelEffortProfile(model="gpt-test", reasoning="cheap")
        with self.assertRaisesRegex(ValueError, "provider"):
            ModelEffortProfile(provider="provider-test")


class CodexEvaluationRunnerTest(unittest.TestCase):
    def test_isolated_subscription_invocation_records_usage_without_api_key(self) -> None:
        captured: dict[str, object] = {}

        def fake_run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            captured.update({"argv": list(argv), **kwargs})
            output = Path(argv[argv.index("--output-last-message") + 1])
            output.write_text(
                json.dumps({"decisions": [_decision("eligible", "promoted")]}),
                encoding="utf-8",
            )
            events = "\n".join(
                [
                    json.dumps({"type": "item.completed", "item": {"type": "agent_message"}}),
                    json.dumps(
                        {
                            "type": "turn.completed",
                            "usage": {
                                "input_tokens": 410,
                                "cached_input_tokens": 30,
                                "output_tokens": 90,
                            },
                        }
                    ),
                ]
            )
            return subprocess.CompletedProcess(argv, 0, events, "")

        runner = CodexEvaluationRunner(
            codex_bin="/fake/codex",
            source_env={
                "PATH": os.environ["PATH"],
                "HOME": "/tmp/test-user",
                "CODEX_HOME": "/tmp/test-user/.codex",
                "OPENAI_API_KEY": "must-not-leak",
            },
            command_runner=fake_run,
        )
        case = _corpus()["cases"][0]
        result = runner.run_batch(
            model="model-test",
            effort="medium",
            policy=_corpus()["policy"],
            cases=[case],
        )

        self.assertIsNone(result.error)
        self.assertEqual(result.usage["input_tokens"], 410)
        self.assertEqual(result.decisions[0]["status"], "promoted")
        self.assertIn("model_reasoning_effort=\"medium\"", captured["argv"])
        self.assertIn("--ignore-user-config", captured["argv"])
        self.assertIn("shell_tool", captured["argv"])
        self.assertIn("tool_suggest", captured["argv"])
        self.assertEqual(captured["env"]["CODEX_HOME"], "/tmp/test-user/.codex")
        self.assertNotIn("OPENAI_API_KEY", captured["env"])
        self.assertEqual(captured["cwd"], Path(captured["argv"][captured["argv"].index("--cd") + 1]))

    def test_any_tool_event_refuses_the_batch(self) -> None:
        def fake_run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            output = Path(argv[argv.index("--output-last-message") + 1])
            output.write_text(
                json.dumps({"decisions": [_decision("eligible", "promoted")]}),
                encoding="utf-8",
            )
            event = json.dumps(
                {"type": "item.completed", "item": {"type": "command_execution"}}
            )
            return subprocess.CompletedProcess(argv, 0, event, "")

        result = CodexEvaluationRunner(command_runner=fake_run).run_batch(
            model="model-test",
            effort="medium",
            policy=_corpus()["policy"],
            cases=[_corpus()["cases"][0]],
        )
        self.assertEqual(result.error, "tool_use_refused")
        self.assertEqual(result.tool_events, ["command_execution"])


class _FixedRunner:
    def run_batch(self, *, model, effort, policy, cases):
        decisions = [
            _decision(case["id"], case["reference"]["status"])
            for case in cases
        ]
        return CodexBatchResult(
            decisions=decisions,
            latency_seconds=0.25,
            usage={"input_tokens": 100, "output_tokens": 20},
            tool_events=[],
        )


class BenchmarkAggregationTest(unittest.TestCase):
    def test_requires_at_least_one_explicit_variant(self) -> None:
        with self.assertRaisesRegex(ValueError, "explicit benchmark model"):
            run_benchmark(_corpus(), variants=(), runner=_FixedRunner())

    def test_reports_quality_latency_and_tokens_without_fake_dollars(self) -> None:
        report = run_benchmark(
            _corpus(),
            variants=(("model-test", "medium"),),
            batch_size=1,
            runner=_FixedRunner(),
        )
        variant = report["variants"][0]
        self.assertEqual(variant["usage"], {"input_tokens": 200, "output_tokens": 40})
        self.assertEqual(variant["latency_seconds"], 0.5)
        self.assertTrue(variant["metrics"]["complete_case_set"])
        self.assertEqual(variant["metrics"]["status_agreement"], 1.0)
        self.assertEqual(variant["metrics"]["promotion_precision_vs_reference"], 1.0)
        self.assertIn("not independent ground truth", report["quality_note"])
        self.assertNotIn("dollars", json.dumps(report).lower())


if __name__ == "__main__":
    unittest.main()
