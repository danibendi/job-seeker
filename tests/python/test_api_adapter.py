from __future__ import annotations

import json
import unittest

from scripts.compass_worker.api import DirectApiAdapter, OpenAICompatibleTransport
from scripts.compass_worker.client import TaskClaim
from tests.python.test_compact_evaluation import context, decision


class Control:
    cancelled = False
    reason = None
    lease_deadline = 10**12

    def __init__(self) -> None:
        self.progress = []

    def report_progress(self, **value):
        self.progress.append(value)
        return True


def claim(kind: str, *, sources=None) -> TaskClaim:
    payload = {"candidateId": "candidate-1"}
    if sources is not None:
        payload["sources"] = sources
    return TaskClaim(
        task={
            "id": "task-1", "kind": kind, "executor": "api", "attemptCount": 1,
            "payload": payload, "checkpoint": {},
        },
        claim_token="attempt-token", lease_expires_at=None,
        heartbeat_interval_seconds=30,
    )


class Transport:
    def __init__(self, outputs, *, web_search=False):
        self.outputs = list(outputs)
        self.web_search = web_search
        self.calls = []

    def check(self):
        pass

    def generate_json(self, **kwargs):
        self.calls.append(kwargs)
        return self.outputs.pop(0), {
            "provider": "synthetic", "model": "test-model", "modelCalls": 1,
            "toolCalls": 0,
        }


class Mcp:
    def __init__(self, loaded):
        self.loaded = loaded
        self.calls = []

    def call(self, name, **arguments):
        self.calls.append((name, arguments))
        if name == "get_task_context":
            return self.loaded
        if name == "complete_linkedin_evaluation":
            return {"outcome": "completed", "state": arguments["status"]}
        if name == "verify_public_source":
            return {
                "server_receipt_id": "receipt-1", "authority": "jobs.example",
                "checked_at": "2030-01-01T00:00:00Z", "initial_url": arguments["url"],
                "final_url": arguments["url"], "http_status": 200,
                "static_html_vacancy_shaped": True, "body_sha256": "a" * 64,
            }
        if name == "save_job":
            return {"outcome": "created"}
        raise AssertionError(name)


class DirectApiAdapterTest(unittest.TestCase):
    def test_question_uses_task_context_and_returns_saved_response_shape(self):
        mcp = Mcp({"request": {"text": "What should I prioritize?"}})
        transport = Transport([{"answer_markdown": "Prioritize the verified role."}])
        adapter = DirectApiAdapter(
            "https://jobs.example", transport, task_kinds=("question",),
            mcp_factory=lambda *_args: mcp,
        )
        result = adapter.run(claim("question"), Control())
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.result["responseMd"], "Prioritize the verified role.")
        self.assertEqual([name for name, _ in mcp.calls], ["get_task_context"])
        self.assertFalse(transport.calls[0]["use_web_search"] if "use_web_search" in transport.calls[0] else False)

    def test_evaluation_reuses_contract_and_persists_before_success(self):
        packet = context()
        packet["candidate"]["id"] = "candidate-1"
        mcp = Mcp({"evaluationContext": packet})
        transport = Transport([decision(status="rejected")])
        control = Control()
        adapter = DirectApiAdapter(
            "https://jobs.example", transport, task_kinds=("linkedin_evaluate",),
            mcp_factory=lambda *_args: mcp,
        )
        result = adapter.run(claim("linkedin_evaluate"), control)
        self.assertEqual(result.status, "succeeded")
        self.assertEqual([name for name, _ in mcp.calls], [
            "get_task_context", "complete_linkedin_evaluation",
        ])
        self.assertEqual(mcp.calls[1][1]["policy_hash"], packet["policyHash"])
        self.assertEqual(len(control.progress), 1)

    def test_public_search_is_exploratory_and_server_verifies_before_save(self):
        policy_hash = "a" * 64
        proposed = {
            "company": "Example", "title": "Program Manager",
            "url": "https://jobs.example/program-manager", "location": "Remote",
            "work_mode": "remote", "description_md": "A complete synthetic vacancy.",
            "fit_score": 85, "fit_analysis_md": "Strong fit based on supplied evidence.",
            "fit_factors": [],
            "policy_evidence": {
                "location_eligible": True, "language_eligible": True,
                "role_eligible": True, "exclusions_clear": True,
                "explanation": "All configured policy gates are supported by the page.",
            },
        }
        mcp = Mcp({"policyHash": policy_hash, "effectivePolicy": {}})
        transport = Transport([{"summary": "Found one verified vacancy.", "jobs": [proposed]}], web_search=True)
        adapter = DirectApiAdapter(
            "https://jobs.example", transport, task_kinds=("search",),
            mcp_factory=lambda *_args: mcp,
        )
        result = adapter.run(claim("search", sources=["public"]), Control())
        self.assertEqual(result.status, "succeeded")
        self.assertFalse(result.result["public_discovery"]["complete"])
        self.assertFalse(result.result["public_discovery"]["source_registry_complete"])
        self.assertEqual([name for name, _ in mcp.calls], [
            "get_task_context", "verify_public_source", "save_job",
        ])
        saved_job = mcp.calls[-1][1]["job"]
        self.assertEqual(saved_job["policy_hash"], policy_hash)
        self.assertEqual(saved_job["source_verification"]["server_receipt_id"], "receipt-1")
        self.assertTrue(transport.calls[0]["use_web_search"])

    def test_search_capability_requires_explicit_provider_web_support(self):
        with self.assertRaisesRegex(ValueError, "WEB_SEARCH"):
            DirectApiAdapter(
                "https://jobs.example", Transport([]), task_kinds=("search",),
            )


class TransportShapeTest(unittest.TestCase):
    def test_openai_compatible_request_has_explicit_model_reasoning_and_schema(self):
        captured = {}

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                pass
            def read(self, _limit):
                return json.dumps({
                    "choices": [{"message": {"content": json.dumps({"ok": True})}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
                }).encode()

        class Opener:
            def open(self, request, timeout):
                captured["body"] = json.loads(request.data)
                captured["timeout"] = timeout
                return Response()

        transport = OpenAICompatibleTransport(
            "https://model.example/v1", "synthetic-secret", "model-1",
            reasoning_effort="medium", web_search=True,
        )
        transport._opener = Opener()
        value, runtime = transport.generate_json(
            system="system", prompt="prompt", schema_name="test",
            schema={"type": "object"}, use_web_search=True,
        )
        self.assertEqual(value, {"ok": True})
        self.assertEqual(captured["body"]["model"], "model-1")
        self.assertEqual(captured["body"]["reasoning_effort"], "medium")
        self.assertEqual(captured["body"]["web_search_options"]["search_context_size"], "medium")
        self.assertEqual(runtime["usage"]["totalTokens"], 12)


if __name__ == "__main__":
    unittest.main()
