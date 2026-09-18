#!/usr/bin/env python3
"""Bounded Job Seeker scheduler and Hermes queue drain.

This is the portable counterpart of the reviewed native clock. It uses the
worker package's public protocol client and pinned 0.1.0 adapter classes. An
empty first claim exits without starting Hermes or making a model call.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import sys

WORKER_ENV_FILE = Path(@@WORKER_ENV_FILE@@)
SCHEDULER_ENV_FILE = Path(@@SCHEDULER_ENV_FILE@@)
LOCK_FILE = Path(@@LOCK_FILE@@)
TASK_TIMEOUT_SECONDS = @@TASK_TIMEOUT_SECONDS@@
QUEUE_DRAIN_SECONDS = @@QUEUE_DRAIN_SECONDS@@
WORKER_BIN_DIRECTORY = @@WORKER_BIN_DIRECTORY@@
KEY = re.compile(r"^[A-Z][A-Z0-9_]*$")


def load_environment(path: Path) -> dict[str, str]:
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_mode & 0o077:
        raise RuntimeError(f"unsafe environment file: {path}")
    values: dict[str, str] = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise RuntimeError(f"invalid environment line {number}: {path}")
        name, encoded = line.split("=", 1)
        if not KEY.fullmatch(name):
            raise RuntimeError(f"invalid environment name at line {number}: {path}")
        parsed = shlex.split(encoded, comments=False, posix=True)
        if len(parsed) != 1:
            raise RuntimeError(f"invalid environment value at line {number}: {path}")
        values[name] = parsed[0]
    return values


def read_secret_file(path_value: str, label: str) -> str:
    path = Path(path_value)
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_mode & 0o077:
        raise RuntimeError(f"unsafe {label} file")
    value = path.read_text(encoding="utf-8").rstrip("\r\n")
    if len(value) < 32 or "\n" in value or "\r" in value:
        raise RuntimeError(f"invalid {label} value")
    return value


def required(values: dict[str, str], name: str) -> str:
    value = values.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


def settings() -> tuple[dict[str, str], str, str]:
    worker = load_environment(WORKER_ENV_FILE)
    scheduler = load_environment(SCHEDULER_ENV_FILE)
    if worker.get("JOB_SEEKER_APP_URL") != scheduler.get("JOB_SEEKER_APP_URL"):
        raise RuntimeError("worker and scheduler origins differ")
    if worker.get("COMPASS_WORKER_EXECUTOR") != "hermes":
        raise RuntimeError("reference clock requires the Hermes executor")
    worker_token = read_secret_file(required(worker, "COMPASS_WORKER_TOKEN_FILE"), "worker token")
    scheduler_token = read_secret_file(required(scheduler, "COMPASS_SCHEDULER_TOKEN_FILE"), "scheduler token")
    if worker_token == scheduler_token:
        raise RuntimeError("worker and scheduler credentials must differ")
    return worker, worker_token, scheduler_token


def install_environment(worker: dict[str, str]) -> None:
    inherited = {
        name: os.environ[name]
        for name in ("HOME", "LANG", "LC_ALL", "SSL_CERT_DIR", "SSL_CERT_FILE", "TERM", "TMPDIR", "TZ",
                     "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME")
        if name in os.environ
    }
    os.environ.clear()
    os.environ.update({"PATH": WORKER_BIN_DIRECTORY + ":/usr/local/bin:/usr/bin:/bin", **inherited, **worker})


def run_check() -> int:
    worker, _, _ = settings()
    required_names = (
        "JOB_SEEKER_APP_URL", "COMPASS_HERMES_BIN", "COMPASS_HERMES_RUNTIME_ROOT", "HERMES_HOME", "HERMES_KANBAN_HOME",
        "COMPASS_HERMES_BOARD", "COMPASS_HERMES_TENANT", "COMPASS_HERMES_PROFILE",
        "COMPASS_HERMES_MODEL", "COMPASS_HERMES_PROVIDER", "COMPASS_HERMES_REASONING",
        "COMPASS_HERMES_EVALUATION_MODEL", "COMPASS_HERMES_EVALUATION_PROVIDER",
        "COMPASS_HERMES_EVALUATION_REASONING", "COMPASS_HERMES_TASK_KINDS",
    )
    for name in required_names:
        required(worker, name)
    from scripts.compass_worker import PROTOCOL_VERSION, __version__
    if __version__ != "0.1.0" or PROTOCOL_VERSION != 1:
        raise RuntimeError("installed Job Seeker worker version does not match this reference")
    print(json.dumps({
        "status": "passed",
        "scope": "protected files and fixed configuration",
        "network": "not_tested",
        "hermesRuntime": "not_started",
        "taskFlow": "not_tested",
        "secretValuesPrinted": False,
    }, sort_keys=True))
    return 0


def run_clock() -> int:
    worker, worker_token, scheduler_token = settings()
    install_environment(worker)
    from scripts.compass_worker.client import CompassClient
    from scripts.compass_worker.hermes import HermesKanbanAdapter
    from scripts.compass_worker.linkedin import SearchRoutingAdapter
    from scripts.compass_worker.runner import WorkerRunner

    app_url = required(worker, "JOB_SEEKER_APP_URL")
    kinds = tuple(item.strip() for item in required(worker, "COMPASS_HERMES_TASK_KINDS").split(",") if item.strip())
    hermes = HermesKanbanAdapter(
        app_url,
        hermes_bin=required(worker, "COMPASS_HERMES_BIN"),
        board=required(worker, "COMPASS_HERMES_BOARD"),
        profile=required(worker, "COMPASS_HERMES_PROFILE"),
        tenant=required(worker, "COMPASS_HERMES_TENANT"),
        timeout_seconds=TASK_TIMEOUT_SECONDS,
        model=required(worker, "COMPASS_HERMES_MODEL"),
        provider=required(worker, "COMPASS_HERMES_PROVIDER"),
        reasoning=required(worker, "COMPASS_HERMES_REASONING"),
        evaluation_model=required(worker, "COMPASS_HERMES_EVALUATION_MODEL"),
        evaluation_provider=required(worker, "COMPASS_HERMES_EVALUATION_PROVIDER"),
        evaluation_reasoning=required(worker, "COMPASS_HERMES_EVALUATION_REASONING"),
    )
    hermes.check()
    tick = CompassClient(app_url, scheduler_token).schedule_tick()
    runner = WorkerRunner(
        CompassClient(app_url, worker_token, task_kinds=kinds),
        {"hermes": SearchRoutingAdapter(app_url, hermes)},
    )
    signal.signal(signal.SIGTERM, lambda number, _frame: runner.request_stop(number))
    signal.signal(signal.SIGINT, lambda number, _frame: runner.request_stop(number))
    print(json.dumps({"scheduleTasksCreated": tick.get("created", 0)}), flush=True)
    result = runner.run(drain=True, max_runtime_seconds=QUEUE_DRAIN_SECONDS)
    print(json.dumps({"workerExit": result, "shutdown": runner.shutdown_diagnostics()}), flush=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()
    if args.check_config:
        return run_check()
    LOCK_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with LOCK_FILE.open("a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"status": "already_running", "modelCalls": 0}))
            return 0
        return run_clock()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "errorClass": type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
