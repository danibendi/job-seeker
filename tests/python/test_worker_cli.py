from __future__ import annotations

import io
import json
import os
import unittest
from contextlib import redirect_stdout
from unittest import mock

from scripts.compass_worker.__main__ import main


class _HermesWithoutEvaluator:
    evaluation_configured = False
    evaluation_configuration_source = None

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    def check(self) -> None:
        pass


class WorkerCheckReportTest(unittest.TestCase):
    def test_unconfigured_hermes_evaluation_is_disabled_and_not_claimed(self) -> None:
        env = {
            "COMPASS_APP_URL": "https://job-seeker.example",
            "COMPASS_WORKER_TOKEN": "synthetic-worker-token-with-enough-length",
            "COMPASS_WORKER_EXECUTOR": "hermes",
            "COMPASS_HERMES_TASK_KINDS": "question,search,linkedin_evaluate",
        }
        output = io.StringIO()
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch(
                "scripts.compass_worker.hermes.HermesKanbanAdapter",
                _HermesWithoutEvaluator,
            ),
            redirect_stdout(output),
        ):
            code = main(["--check", "--json"])

        report = json.loads(output.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(report["taskKinds"], ["question", "search"])
        self.assertEqual(report["checks"]["compactEvaluation"]["status"], "disabled")
        self.assertEqual(report["checks"]["providerRuntime"]["status"], "not_tested")


if __name__ == "__main__":
    unittest.main()
