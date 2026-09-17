"""Command-line launcher for Job Seeker task workers."""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path

from .client import CompassClient
from .codex import CodexAdapter, REPO_ROOT
from .runner import WorkerRunner
from . import PROTOCOL_VERSION, __version__


def _bounded_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.environ.get(name)
    value = default if raw is None else float(raw)
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum:g} and {maximum:g}")
    return value


def _read_secret(name: str) -> str:
    direct = os.environ.get(name)
    file_name = os.environ.get(f"{name}_FILE")
    if direct and file_name:
        raise ValueError(f"Set only one of {name} and {name}_FILE")
    if file_name:
        path = Path(file_name).expanduser()
        value = path.read_text(encoding="utf-8").strip()
    else:
        value = (direct or "").strip()
    if not value:
        raise ValueError(f"{name} or {name}_FILE is required")
    if value.startswith("op://"):
        raise ValueError(f"{name} is still a 1Password reference; launch through with-secrets")
    return value


def _optional_secret(name: str) -> str | None:
    if name not in os.environ and f"{name}_FILE" not in os.environ:
        return None
    return _read_secret(name)


def _tool_allowlist(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "")
    tools = tuple(dict.fromkeys(item.strip() for item in raw.split(",") if item.strip()))
    if any(not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", tool) for tool in tools):
        raise ValueError(f"{name} contains an invalid tool name")
    return tools


def _task_kinds(name: str, default: str) -> tuple[str, ...]:
    raw = os.environ.get(name, default)
    kinds = tuple(dict.fromkeys(item.strip() for item in raw.split(",") if item.strip()))
    allowed = {"question", "search", "linkedin_evaluate"}
    if not kinds or any(kind not in allowed for kind in kinds):
        raise ValueError(f"{name} must contain question, search, and/or linkedin_evaluate")
    return kinds


def _boolean(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    if raw.strip().lower() in {"1", "true", "yes", "on"}:
        return True
    if raw.strip().lower() in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Job Seeker background task worker")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Claim at most one task, then exit")
    mode.add_argument("--check", action="store_true", help="Validate local configuration without calling the API")
    mode.add_argument("--schedule-tick", action="store_true", help="Run one deterministic scheduler tick, then exit")
    parser.add_argument("--max-polls", type=int, help="Stop after this many claim polls")
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable --check report")
    parser.add_argument("--log-level", choices=("DEBUG", "INFO", "WARNING", "ERROR"), default="INFO")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(message)s")
    if args.max_polls is not None and args.max_polls < 1:
        raise SystemExit("--max-polls must be at least 1")
    if args.json and not args.check:
        raise SystemExit("--json is available only with --check")
    try:
        app_url = os.environ.get("JOB_SEEKER_APP_URL") or os.environ["COMPASS_APP_URL"]
        timeout = _bounded_float("COMPASS_HTTP_TIMEOUT_SECONDS", 30, 1, 120)
        token_name = "COMPASS_SCHEDULER_TOKEN" if args.schedule_tick else "COMPASS_WORKER_TOKEN"
        token = _read_secret(token_name)
        executor = os.environ.get("COMPASS_WORKER_EXECUTOR", "api").strip().lower()
        configured_kinds: tuple[str, ...] | None = None
        if executor == "api":
            configured_kinds = _task_kinds("COMPASS_API_TASK_KINDS", "question,linkedin_evaluate")
        elif executor == "hermes":
            configured_kinds = _task_kinds(
                "COMPASS_HERMES_TASK_KINDS", "question,search,linkedin_evaluate"
            )
        client = CompassClient(
            app_url, token, timeout_seconds=timeout, task_kinds=configured_kinds,
        )

        if args.schedule_tick:
            result = client.schedule_tick()
            print(f"Scheduler tick accepted ({result.get('created', 0)} tasks created)")
            return 0

        task_timeout = _bounded_float("COMPASS_TASK_TIMEOUT_SECONDS", 1_800, 1, 86_400)
        if executor == "api":
            from .api import DirectApiAdapter, OpenAICompatibleTransport

            transport = OpenAICompatibleTransport(
                os.environ["COMPASS_API_BASE_URL"],
                _read_secret("COMPASS_API_KEY"),
                os.environ["COMPASS_API_MODEL"],
                reasoning_effort=os.environ.get("COMPASS_API_REASONING_EFFORT") or None,
                timeout_seconds=_bounded_float("COMPASS_API_TIMEOUT_SECONDS", 120, 1, 300),
                structured_output=os.environ.get(
                    "COMPASS_API_STRUCTURED_OUTPUT", "json_schema"
                ).strip().lower(),
                web_search=_boolean("COMPASS_API_WEB_SEARCH"),
            )
            adapter = DirectApiAdapter(
                app_url,
                transport,
                task_kinds=configured_kinds or (),
            )
        elif executor == "codex":
            browser_mcp_url = os.environ.get("COMPASS_CODEX_BROWSER_MCP_URL") or None
            browser_mcp_token = _optional_secret("COMPASS_CODEX_BROWSER_MCP_TOKEN")
            if browser_mcp_token and not browser_mcp_url:
                raise ValueError("COMPASS_CODEX_BROWSER_MCP_TOKEN requires a browser MCP URL")
            adapter = CodexAdapter(
                app_url,
                codex_bin=os.environ.get("COMPASS_CODEX_BIN", "codex"),
                workspace=os.environ.get("COMPASS_WORKSPACE", str(REPO_ROOT)),
                timeout_seconds=task_timeout,
                sandbox=os.environ.get("COMPASS_CODEX_SANDBOX", "workspace-write"),
                model=os.environ.get("COMPASS_CODEX_MODEL") or None,
                browser_mcp_url=browser_mcp_url,
                browser_mcp_token=browser_mcp_token,
                browser_mcp_enabled_tools=_tool_allowlist(
                    "COMPASS_CODEX_BROWSER_MCP_ENABLED_TOOLS"
                ),
            )
        elif executor == "hermes":
            from .hermes import HermesKanbanAdapter

            adapter = HermesKanbanAdapter(
                app_url,
                hermes_bin=os.environ.get("COMPASS_HERMES_BIN", "hermes"),
                board=os.environ.get("COMPASS_HERMES_BOARD", "compass"),
                profile=os.environ.get("COMPASS_HERMES_PROFILE", "compass-worker"),
                tenant=os.environ.get("COMPASS_HERMES_TENANT", "job-seeker"),
                poll_seconds=_bounded_float("COMPASS_HERMES_POLL_SECONDS", 2, 0.05, 300),
                timeout_seconds=task_timeout,
                command_timeout_seconds=_bounded_float(
                    "COMPASS_HERMES_COMMAND_TIMEOUT_SECONDS", 30, 1, 300
                ),
                model=os.environ.get("COMPASS_HERMES_MODEL") or None,
                provider=os.environ.get("COMPASS_HERMES_PROVIDER") or None,
                reasoning=os.environ.get("COMPASS_HERMES_REASONING") or None,
                evaluation_model=os.environ.get("COMPASS_HERMES_EVALUATION_MODEL") or None,
                evaluation_provider=os.environ.get("COMPASS_HERMES_EVALUATION_PROVIDER") or None,
                evaluation_reasoning=os.environ.get("COMPASS_HERMES_EVALUATION_REASONING") or None,
            )
            if not adapter.evaluation_configured and "linkedin_evaluate" in configured_kinds:
                configured_kinds = tuple(
                    kind for kind in configured_kinds if kind != "linkedin_evaluate"
                )
                if not configured_kinds:
                    raise ValueError(
                        "Hermes linkedin_evaluate requires explicit model, provider, and reasoning configuration"
                    )
                client.task_kinds = configured_kinds
        else:
            raise ValueError("COMPASS_WORKER_EXECUTOR must be api, codex, or hermes")
        adapter.check()
        if args.check:
            if args.json:
                checks = {
                    "configuration": {"status": "passed"},
                    "appApi": {"status": "not_tested"},
                    "providerRuntime": {"status": "not_tested"},
                    "taskFlow": {"status": "not_tested"},
                }
                if executor == "hermes":
                    checks["compactEvaluation"] = (
                        {
                            "status": "passed",
                            "scope": "configuration",
                            "source": adapter.evaluation_configuration_source,
                        }
                        if adapter.evaluation_configured
                        else {
                            "status": "disabled",
                            "reason": "explicit model, provider, and reasoning are not configured",
                        }
                    )
                print(json.dumps({
                    "component": "job-seeker-worker",
                    "version": __version__,
                    "protocolVersion": PROTOCOL_VERSION,
                    "checkedAt": datetime.now(timezone.utc).isoformat(),
                    "executor": executor,
                    "taskKinds": list(configured_kinds or ()),
                    "checks": checks,
                }, sort_keys=True))
            else:
                print(f"Job Seeker worker configuration is valid (executor={executor})")
                if executor == "hermes" and not adapter.evaluation_configured:
                    print("Hermes compact evaluation is disabled (explicit model, provider, and reasoning are not configured)")
            return 0
        if executor == "hermes":
            from .linkedin import SearchRoutingAdapter

            adapter = SearchRoutingAdapter(app_url, adapter)
        runner = WorkerRunner(
            client,
            {executor: adapter},
            poll_seconds=_bounded_float("COMPASS_POLL_SECONDS", 30, 1, 300),
        )
        signal.signal(signal.SIGTERM, lambda signum, _frame: runner.request_stop(signum))
        signal.signal(signal.SIGINT, lambda signum, _frame: runner.request_stop(signum))
        return runner.run(once=args.once, max_polls=args.max_polls)
    except (KeyError, OSError, ValueError) as error:
        logging.error("Configuration error: %s", error)
        return 2


if __name__ == "__main__":
    sys.exit(main())
