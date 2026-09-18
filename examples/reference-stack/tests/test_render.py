from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RENDER = ROOT / "render.py"


class ReferenceStackRendererTest(unittest.TestCase):
    def synthetic_configuration(self, root: Path) -> Path:
        secrets = root / "secrets"
        secrets.mkdir(mode=0o700)
        values = {
            "databasePooledFile": "postgresql://ep-synthetic-pooler.localhost/job_seeker?sslmode=require",
            "databaseDirectFile": "postgresql://ep-synthetic.localhost/job_seeker?sslmode=require",
            "authPasswordHashFile": "$2b$12$" + "x" * 53,
            "sessionSecretFile": "s" * 64,
            "ownerMcpTokenFile": "o" * 64,
            "workerTokenFile": "w" * 64,
            "schedulerTokenFile": "q" * 64,
        }
        config = json.loads((ROOT / "stack.example.json").read_text(encoding="utf-8"))
        output = root / "generated"
        config["worker"]["environmentFile"] = str(output / "worker.env")
        config["worker"]["schedulerEnvironmentFile"] = str(output / "scheduler.env")
        config["worker"]["clockScript"] = str(output / "job_seeker_clock.py")
        for name, value in values.items():
            path = secrets / name
            path.write_text(value + "\n", encoding="utf-8")
            os.chmod(path, 0o600)
            config["secrets"][name] = str(path)
        path = root / "stack.json"
        path.write_text(json.dumps(config, indent=2), encoding="utf-8")
        os.chmod(path, 0o600)
        return path

    def run_renderer(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(RENDER), *args],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_default_is_write_free(self):
        result = self.run_renderer("--config", str(ROOT / "stack.example.json"))
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["mode"], "dry-run")
        self.assertFalse(report["secretFilesRead"])

    def test_write_and_generated_check_use_protected_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = self.synthetic_configuration(root)
            output = root / "generated"
            rendered = self.run_renderer("--config", str(config), "--write", "--output", str(output))
            self.assertEqual(rendered.returncode, 0, rendered.stderr)
            for path in output.iterdir():
                mode = stat.S_IMODE(path.stat().st_mode)
                self.assertIn(mode, {0o600, 0o700}, path.name)
                self.assertFalse(path.is_symlink())
            checked = self.run_renderer("--check-generated", str(output))
            self.assertEqual(checked.returncode, 0, checked.stderr)
            report = json.loads(checked.stdout)
            self.assertEqual(report["status"], "passed")
            self.assertFalse(report["secretValuesPrinted"])
            app = (output / "app.env").read_text(encoding="utf-8")
            self.assertIn("COMPASS_WORKERS_JSON=", app)
            self.assertNotIn("REPLACE_ME", app)
            profile = (output / "hermes-profile.yaml").read_text(encoding="utf-8")
            self.assertIn("${COMPASS_TASK_TOKEN}", profile)
            native = json.loads((output / "native-job.json").read_text(encoding="utf-8"))
            self.assertTrue(native["no_agent"])
            self.assertFalse(native["enabled"])
            compiled = subprocess.run(
                [sys.executable, "-m", "py_compile", str(output / "job_seeker_clock.py")],
                check=False, capture_output=True, text=True,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            worker_env = output / "worker.env"
            scheduler_env = output / "scheduler.env"
            worker_env.write_text(
                worker_env.read_text(encoding="utf-8").replace(
                    "/var/lib/job-seeker/secrets/worker-token",
                    str(root / "secrets" / "workerTokenFile"),
                ), encoding="utf-8",
            )
            scheduler_env.write_text(
                scheduler_env.read_text(encoding="utf-8").replace(
                    "/var/lib/job-seeker/secrets/scheduler-token",
                    str(root / "secrets" / "schedulerTokenFile"),
                ), encoding="utf-8",
            )
            clock_script = output / "job_seeker_clock.py"
            clock_script.write_text(
                clock_script.read_text(encoding="utf-8").replace(
                    "/run/job-seeker/clock.lock", str(root / "clock.lock")
                ),
                encoding="utf-8",
            )
            checked_clock = subprocess.run(
                [sys.executable, str(clock_script), "--check-config"],
                check=False, capture_output=True, text=True,
                env={**os.environ, "PYTHONPATH": str(ROOT.parent.parent)},
            )
            self.assertEqual(checked_clock.returncode, 0, checked_clock.stderr)
            self.assertEqual(json.loads(checked_clock.stdout)["taskFlow"], "not_tested")

            # Exercise the generated clock's real orchestration path with an
            # empty-queue worker fixture. The fake adapter never starts Hermes,
            # so this proves the wrapper reaches bounded drain without a model.
            fake = root / "fake" / "scripts" / "compass_worker"
            fake.mkdir(parents=True)
            (fake / "__init__.py").write_text(
                '__version__ = "0.1.0"\nPROTOCOL_VERSION = 1\n', encoding="utf-8"
            )
            (fake / "client.py").write_text(
                "class CompassClient:\n"
                "    def __init__(self, *args, **kwargs): pass\n"
                "    def schedule_tick(self): return {'created': 0}\n",
                encoding="utf-8",
            )
            (fake / "hermes.py").write_text(
                "class HermesKanbanAdapter:\n"
                "    def __init__(self, *args, **kwargs): pass\n"
                "    def check(self): return None\n",
                encoding="utf-8",
            )
            (fake / "linkedin.py").write_text(
                "class SearchRoutingAdapter:\n"
                "    def __init__(self, *args, **kwargs): pass\n",
                encoding="utf-8",
            )
            (fake / "runner.py").write_text(
                "class WorkerRunner:\n"
                "    def __init__(self, *args, **kwargs): self.seen = False\n"
                "    def request_stop(self, number): pass\n"
                "    def run(self, *, drain, max_runtime_seconds):\n"
                "        assert drain and max_runtime_seconds == 1800\n"
                "        self.seen = True\n"
                "        return 0\n"
                "    def shutdown_diagnostics(self):\n"
                "        return {'emptyQueueFixture': self.seen, 'modelCalls': 0}\n",
                encoding="utf-8",
            )
            (fake.parent / "__init__.py").write_text("", encoding="utf-8")
            invoked_clock = subprocess.run(
                [sys.executable, str(clock_script)],
                check=False, capture_output=True, text=True,
                env={**os.environ, "PYTHONPATH": str(root / "fake")},
            )
            self.assertEqual(invoked_clock.returncode, 0, invoked_clock.stderr)
            lines = [json.loads(line) for line in invoked_clock.stdout.splitlines()]
            self.assertEqual(lines[0], {"scheduleTasksCreated": 0})
            self.assertEqual(lines[1]["shutdown"]["modelCalls"], 0)
            self.assertTrue(lines[1]["shutdown"]["emptyQueueFixture"])

    def test_write_rejects_permissive_secret_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = self.synthetic_configuration(root)
            config = json.loads(config_path.read_text(encoding="utf-8"))
            worker = Path(config["secrets"]["workerTokenFile"])
            os.chmod(worker, 0o644)
            result = self.run_renderer(
                "--config", str(config_path),
                "--write", "--output", str(root / "generated"),
            )
            self.assertNotEqual(result.returncode, 0)
            report = json.loads(result.stderr)
            self.assertEqual(report["status"], "failed")
            self.assertFalse(report["secretValuesPrinted"])


if __name__ == "__main__":
    unittest.main()
