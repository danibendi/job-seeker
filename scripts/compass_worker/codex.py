"""Codex CLI adapter for Compass worker tasks."""

from __future__ import annotations

import json
import os
import re
import selectors
import signal
import subprocess
import tempfile
import time
from collections import Counter, deque
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

from .client import TaskClaim, encode_json_body, join_app_path, normalize_app_url
from .evaluation import ModelEffortProfile
from .runner import AdapterResult, TaskControl

REPO_ROOT = Path(__file__).resolve().parents[2]
_RESOURCES = Path(__file__).with_name("resources")
DEFAULT_SCHEMA = _RESOURCES / "task-result.schema.json"
DEFAULT_INSTRUCTIONS = _RESOURCES / "worker-instructions.md"
_MAX_EVENT_OUTPUT_BYTES = 10_000_000
_MAX_EVENT_LINE_BYTES = 1_000_000
_MAX_STDERR_TAIL_BYTES = 32_000
_PROCESS_TERMINATE_GRACE_SECONDS = 5.0
_VERSION_PROBE_SECONDS = 10.0
_RESULT_KEYS = {"status", "summary", "details", "artifacts", "checkpoint", "retryable"}
_ARTIFACT_KEYS = {"kind", "id", "url", "label"}
TASK_KINDS = ("search", "question", "linkedin_evaluate")

# Codex features that give a task more reach than its task MCP capability and,
# for public search, live web search. The worker never needs a shell, ChatGPT
# connectors, plugins, hooks, memories, image tools, browser/computer control
# or sub-agents. Code mode stays enabled: Codex 0.171 routes MCP tool calls
# through it, and without it the task tools are unreachable. A feature that a
# future CLI removes is still accepted as a no-op; an unknown name is reported
# as a CLI incompatibility rather than silently widening access.
DISABLED_FEATURES = (
    "apps",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "goals",
    "hooks",
    "image_generation",
    "in_app_browser",
    "memories",
    "multi_agent",
    "multi_agent_v2",
    "plugins",
    "remote_plugin",
    "shell_snapshot",
    "shell_tool",
    "skill_mcp_dependency_install",
    "skill_search",
    "sleep_tool",
    "tool_suggest",
    "unified_exec",
    "view_image",
)

_SAFE_ENV_NAMES = {
    "CODEX_HOME",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TERM",
    "TMPDIR",
    "TZ",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
}

# Bounded categories derived from Codex error events and its diagnostic stream.
# Raw messages, prompts and events never leave the adapter.
_FAILURE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # Ordered by specificity. Failures attributable to a named MCP server are
    # checked before generic authorization text, so a 401 from the app's task
    # endpoint or the browser is never mistaken for a lost ChatGPT sign-in.
    ("usage_limit", re.compile(
        r"usage limit|usage_limit|purchase more credits|upgrade to (plus|pro)|"
        r"insufficient_quota|exceeded your current quota", re.I)),
    ("cli_incompatible", re.compile(
        r"unknown feature flag|unknown configuration field|unexpected argument|"
        r"unrecognized (option|argument|subcommand)|error loading config", re.I)),
    ("task_tools_unavailable", re.compile(
        r"mcp servers? failed to initialize: compass|compass: handshaking|"
        r"mcp client for [`'\"]?compass|mcp_servers\.compass", re.I)),
    ("browser_unavailable", re.compile(
        r"mcp servers? failed to initialize: browser|browser: handshaking|"
        r"mcp client for [`'\"]?browser|mcp_servers\.browser", re.I)),
    ("model_unavailable", re.compile(
        r"model\b.{0,80}\b(is not supported|not supported when|does not exist|not found|"
        r"is not available|unavailable)|model_not_found|unsupported model", re.I)),
    ("login_required", re.compile(
        r"\b401\b|unauthori[sz]ed|not logged in|log ?in again|sign ?in again|"
        r"codex login|refresh token|token (has )?expired|could not be refreshed|"
        r"authentication (is )?required", re.I)),
    ("rate_limited", re.compile(r"\b429\b|rate.?limit|too many requests", re.I)),
    ("network", re.compile(
        r"stream disconnected|error sending request|connection (refused|reset|closed)|"
        r"timed out|dns error|network is unreachable|temporarily unavailable|"
        r"\b50[234]\b|service unavailable", re.I)),
)

_FAILURE_OUTCOMES: dict[str, tuple[str, bool, str | None, str]] = {
    # category: (status, retryable, worker pause reason, owner-facing summary)
    "usage_limit": (
        "waiting_for_user", False, "usage_limit",
        "Codex stopped because the ChatGPT subscription usage limit was reached. "
        "This worker is paused, so other tasks stay queued. Resume the worker when access returns, then retry this task.",
    ),
    "login_required": (
        "waiting_for_user", False, "login_required",
        "Codex stopped because the worker's ChatGPT sign-in is missing or expired. "
        "This worker is paused. Sign in again on the worker host, resume the worker, then retry this task.",
    ),
    "cli_incompatible": (
        "failed", False, None,
        "This Codex CLI version rejected the worker's fixed settings. Update the worker package or Codex, then retry.",
    ),
    "model_unavailable": (
        "failed", False, None,
        "Codex could not use the configured model with this account. Change the worker's model setting, then retry.",
    ),
    "task_tools_unavailable": (
        "failed", True, None,
        "Codex could not connect to Job Seeker's task tools. The task will be retried.",
    ),
    "browser_unavailable": (
        "failed", True, None,
        "Codex could not reach the configured browser for LinkedIn collection. The task will be retried.",
    ),
    "rate_limited": (
        "failed", True, None,
        "Codex was briefly rate limited by the model provider. The task will be retried.",
    ),
    "network": (
        "failed", True, None,
        "Codex lost its connection to the model provider. The task will be retried.",
    ),
}


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=True)


# The diagnostic stream mixes the provider, MCP clients and teardown logs, so a
# bare 401 there may come from the task endpoint or the browser. Only explicit
# sign-in wording counts as a lost ChatGPT sign-in from that stream.
_DIAGNOSTIC_LOGIN = re.compile(
    r"not logged in|log ?in again|sign ?in again|codex login|refresh token|"
    r"token (has )?expired|could not be refreshed|authentication (is )?required", re.I)


def classify_codex_failure(messages: list[str], diagnostics: str = "") -> str | None:
    """Map Codex error text to one bounded category, never returning the text."""

    # Turn errors arrive as JSON events. Newest first: a failed turn ends with
    # its terminal error, and an earlier transient error must not mask it.
    for text in reversed(messages):
        for category, pattern in _FAILURE_PATTERNS:
            if text and pattern.search(text):
                return category
    # Failures before a turn (configuration, MCP startup) appear only in the
    # diagnostic stream. Read it whole, most specific category first, so a
    # multi-line error keeps its context and trailing teardown lines do not
    # override it.
    if diagnostics:
        for category, pattern in _FAILURE_PATTERNS:
            if (_DIAGNOSTIC_LOGIN if category == "login_required" else pattern).search(diagnostics):
                return category
    return None


class _EventLog:
    """Incrementally read Codex JSONL events while keeping only bounded facts."""

    def __init__(self) -> None:
        self._pending = b""
        self._skipping_line = False
        self.usage: Counter[str] = Counter()
        self.tool_calls: Counter[str] = Counter()
        self.tool_failures = 0
        self.errors: deque[str] = deque(maxlen=8)

    def feed(self, chunk: bytes) -> None:
        data = self._pending + chunk
        lines = data.split(b"\n")
        self._pending = lines.pop()
        for line in lines:
            if self._skipping_line:
                self._skipping_line = False
                continue
            self._line(line)
        if len(self._pending) > _MAX_EVENT_LINE_BYTES:
            self._pending = b""
            self._skipping_line = True

    def finish(self) -> None:
        if self._pending and not self._skipping_line:
            self._line(self._pending)
        self._pending = b""

    def _line(self, line: bytes) -> None:
        try:
            event = json.loads(line)
        except (UnicodeDecodeError, ValueError, RecursionError):
            return
        if not isinstance(event, dict):
            return
        kind = event.get("type")
        if kind == "turn.completed" and isinstance(event.get("usage"), dict):
            for key, value in event["usage"].items():
                if isinstance(key, str) and len(key) <= 60 and type(value) is int and value >= 0:
                    self.usage[key] += value
        elif kind == "error" and isinstance(event.get("message"), str):
            self.errors.append(event["message"][:1_000])
        elif kind == "turn.failed" and isinstance(event.get("error"), dict):
            message = event["error"].get("message")
            if isinstance(message, str):
                self.errors.append(message[:1_000])
        elif kind == "item.completed" and isinstance(event.get("item"), dict):
            item = event["item"]
            item_type = item.get("type")
            if item_type == "mcp_tool_call":
                server, tool = item.get("server"), item.get("tool")
                name = (
                    f"{server}.{tool}"
                    if isinstance(server, str) and isinstance(tool, str)
                    and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", f"{server}.{tool}")
                    else "mcp"
                )
                self.tool_calls[name] += 1
                if item.get("status") == "failed" or item.get("error"):
                    self.tool_failures += 1
            elif item_type == "web_search":
                self.tool_calls["web_search"] += 1
            elif isinstance(item_type, str) and item_type not in {"agent_message", "reasoning", "error", "todo_list"}:
                self.tool_calls[item_type[:60]] += 1


class CodexAdapter:
    def __init__(
        self,
        app_url: str,
        *,
        codex_bin: str = "codex",
        workspace: str | Path | None = None,
        schema_path: str | Path = DEFAULT_SCHEMA,
        instructions_path: str | Path = DEFAULT_INSTRUCTIONS,
        timeout_seconds: float = 1_800,
        sandbox: str = "read-only",
        model: str | None = None,
        reasoning_effort: str | None = None,
        kind_profiles: Mapping[str, ModelEffortProfile] | None = None,
        codex_home: str | Path | None = None,
        browser_mcp_url: str | None = None,
        browser_mcp_token: str | None = None,
        browser_mcp_enabled_tools: tuple[str, ...] = (),
        source_env: Mapping[str, str] | None = None,
    ):
        if sandbox not in {"read-only", "workspace-write", "danger-full-access"}:
            raise ValueError("Invalid Codex sandbox")
        self.app_url = normalize_app_url(app_url)
        self.codex_bin = codex_bin
        # Without an explicit workspace every task runs in its own empty
        # temporary directory, so no repository or host file is the task root.
        self.workspace = Path(workspace).resolve() if workspace is not None else None
        self.schema_path = Path(schema_path).resolve()
        self.instructions_path = Path(instructions_path).resolve()
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self.sandbox = sandbox
        self.default_profile = ModelEffortProfile(model=model, reasoning=reasoning_effort)
        self.kind_profiles = dict(kind_profiles or {})
        if any(kind not in TASK_KINDS for kind in self.kind_profiles):
            raise ValueError("Codex model profiles must name question, search, or linkedin_evaluate")
        self.codex_home = Path(codex_home).expanduser().resolve() if codex_home else None
        self.browser_mcp_url = self._validate_browser_mcp(
            browser_mcp_url, browser_mcp_enabled_tools
        )
        self.browser_mcp_token = browser_mcp_token
        self.browser_mcp_enabled_tools = browser_mcp_enabled_tools
        self.source_env = dict(os.environ if source_env is None else source_env)
        # Relative executables and PATH entries resolve against the directory
        # the worker started in, never the per-task workspace.
        self._launch_directory = Path.cwd()
        self.cli_version: str | None = None

    @staticmethod
    def _validate_browser_mcp(url: str | None, tools: tuple[str, ...]) -> str | None:
        if url is None:
            if tools:
                raise ValueError("Browser MCP tools require COMPASS_CODEX_BROWSER_MCP_URL")
            return None
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Browser MCP URL must be absolute HTTP(S)")
        if parsed.scheme != "https" and host not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Browser MCP URL must use HTTPS except on loopback")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Browser MCP URL must not contain credentials, a query, or a fragment")
        if not tools:
            raise ValueError("Browser MCP requires an explicit enabled-tools allowlist")
        return url

    def _validate_result_schema(self) -> None:
        try:
            configured_schema = json.loads(self.schema_path.read_bytes())
            fixed_schema = json.loads(DEFAULT_SCHEMA.read_bytes())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Codex result schema must contain valid JSON") from None
        if configured_schema != fixed_schema:
            raise ValueError("Codex result schema must match the fixed worker result contract")

    def _resolution_root(self) -> Path:
        return self.workspace or self._launch_directory

    def _resolved_executable(self) -> Path | None:
        executable = self.codex_bin
        root = self._resolution_root()
        if os.path.sep in executable:
            candidate = Path(executable)
            if not candidate.is_absolute():
                candidate = root / candidate
            return candidate if candidate.is_file() and os.access(candidate, os.X_OK) else None
        path_value = self.source_env.get("PATH", os.defpath)
        for part in path_value.split(os.pathsep):
            directory = Path(part or ".")
            if not directory.is_absolute():
                directory = root / directory
            candidate = directory / executable
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return candidate
        return None

    def check(self) -> None:
        if self.workspace is not None and not self.workspace.is_dir():
            raise ValueError(f"Codex workspace does not exist: {self.workspace}")
        if self.codex_home is not None and not self.codex_home.is_dir():
            raise ValueError(f"Codex home does not exist: {self.codex_home}")
        for path in (self.schema_path, self.instructions_path):
            if not path.is_file():
                raise ValueError(f"Required Codex worker file does not exist: {path}")
        self._validate_result_schema()
        if self._resolved_executable() is None:
            if os.path.sep in self.codex_bin:
                raise ValueError(f"Codex executable is not runnable: {self.codex_bin}")
            raise ValueError(f"Codex executable was not found on PATH: {self.codex_bin}")

    def probe_version(self) -> str | None:
        """Record the CLI version for run evidence. check() never runs the CLI."""

        executable = self._resolved_executable()
        if executable is None:
            return None
        try:
            completed = subprocess.run(
                [str(executable), "--version"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                cwd=self._resolution_root(),
                env=self._base_env(),
                timeout=_VERSION_PROBE_SECONDS,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        match = re.search(rb"(\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,40})", completed.stdout[:4_096])
        self.cli_version = match.group(1).decode("ascii") if completed.returncode == 0 and match else None
        return self.cli_version

    def profile_for(self, kind: object) -> ModelEffortProfile:
        selected = self.kind_profiles.get(kind) if isinstance(kind, str) else None
        if selected is None:
            return self.default_profile
        return ModelEffortProfile(
            model=selected.model or self.default_profile.model,
            reasoning=selected.reasoning or self.default_profile.reasoning,
        )

    @staticmethod
    def _sources(task: Mapping[str, Any]) -> set[str]:
        payload = task.get("payload")
        sources = payload.get("sources") if isinstance(payload, dict) else None
        return {item for item in sources if isinstance(item, str)} if isinstance(sources, list) else set()

    def _web_search_mode(self, task: Mapping[str, Any]) -> str:
        return "live" if task.get("kind") == "search" and "public" in self._sources(task) else "disabled"

    def _uses_browser(self, task: Mapping[str, Any]) -> bool:
        # Only LinkedIn collection needs a browser. Questions, evaluations of
        # stored evidence and public-web search must not depend on its health.
        return bool(
            self.browser_mcp_url
            and task.get("kind") == "search"
            and "linkedin" in self._sources(task)
        )

    def _task_timeout(self, task: dict[str, Any]) -> float:
        values = [self.timeout_seconds]
        payload = task.get("payload")
        if isinstance(payload, dict):
            direct = payload.get("timeout_seconds")
            limits = payload.get("limits")
            limited = limits.get("time_seconds") if isinstance(limits, dict) else None
            budgets = payload.get("budgets")
            budget_time = None
            if isinstance(budgets, dict):
                for key in ("maxDurationSeconds", "timeSeconds", "timeoutSeconds", "maxRuntimeSeconds"):
                    if key in budgets:
                        budget_time = budgets[key]
                        break
            for value in (direct, limited, budget_time):
                if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                    values.append(float(value))
        return max(1.0, min(values))

    def _prompt(self, claim: TaskClaim) -> str:
        instructions = self.instructions_path.read_text(encoding="utf-8")
        task_context = {
            "task_id": claim.id,
            "kind": claim.task.get("kind"),
            "payload": claim.task.get("payload", {}),
            "checkpoint": claim.task.get("checkpoint"),
            "attempt": claim.task.get("attemptCount", claim.task.get("attempt_count")),
        }
        return (
            instructions.rstrip()
            + "\n\n<compass_task_data>\n"
            + json.dumps(task_context, ensure_ascii=False, indent=2)
            + "\n</compass_task_data>\n"
        )

    def _base_env(self) -> dict[str, str]:
        child = {name: self.source_env[name] for name in _SAFE_ENV_NAMES if name in self.source_env}
        child.setdefault("PATH", os.defpath)
        if self.codex_home is not None:
            child["CODEX_HOME"] = str(self.codex_home)
        return child

    def _child_env(self, claim: TaskClaim) -> dict[str, str]:
        child = self._base_env()
        child["COMPASS_APP_URL"] = self.app_url.rstrip("/")
        child["COMPASS_TASK_ID"] = claim.id
        child["COMPASS_TASK_ATTEMPT"] = str(
            claim.task.get("attemptCount", claim.task.get("attempt_count", 1))
        )
        child["COMPASS_TASK_TOKEN"] = claim.claim_token
        if self.browser_mcp_token and self._uses_browser(claim.task):
            child["COMPASS_CODEX_BROWSER_MCP_TOKEN"] = self.browser_mcp_token
        return child

    def _argv(self, output_path: Path, task: Mapping[str, Any], workspace: Path) -> list[str]:
        mcp_url = join_app_path(self.app_url, "/api/worker/mcp")
        profile = self.profile_for(task.get("kind"))
        # Launch the executable resolved against the worker's directory: the
        # child's working directory is the per-task workspace, where a relative
        # path or PATH entry would point somewhere else.
        executable = self._resolved_executable()
        argv = [
            str(executable) if executable is not None else self.codex_bin,
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "--skip-git-repo-check",
            "--json",
            "--color",
            "never",
            "--sandbox",
            self.sandbox,
        ]
        for feature in DISABLED_FEATURES:
            argv.extend(["--disable", feature])
        argv.extend([
            "-c",
            'approval_policy="never"',
            "-c",
            'shell_environment_policy.inherit="none"',
            "-c",
            "include_apps_instructions=false",
            "-c",
            f"web_search={_toml_string(self._web_search_mode(task))}",
            "-c",
            f"mcp_servers.compass.url={_toml_string(mcp_url)}",
            "-c",
            'mcp_servers.compass.bearer_token_env_var="COMPASS_TASK_TOKEN"',
            "-c",
            "mcp_servers.compass.required=true",
            "-c",
            'mcp_servers.compass.default_tools_approval_mode="approve"',
        ])
        if profile.reasoning:
            argv.extend(["-c", f"model_reasoning_effort={_toml_string(profile.reasoning)}"])
        argv.extend([
            "--output-schema",
            str(self.schema_path),
            "--output-last-message",
            str(output_path),
            "--cd",
            str(workspace),
        ])
        if profile.model:
            argv.extend(["--model", profile.model])
        if self._uses_browser(task):
            argv.extend(
                [
                    "-c",
                    f"mcp_servers.browser.url={_toml_string(self.browser_mcp_url or '')}",
                    "-c",
                    "mcp_servers.browser.required=true",
                    "-c",
                    'mcp_servers.browser.default_tools_approval_mode="approve"',
                    "-c",
                    "mcp_servers.browser.enabled_tools="
                    + json.dumps(list(self.browser_mcp_enabled_tools)),
                ]
            )
            if self.browser_mcp_token:
                argv.extend(
                    [
                        "-c",
                        'mcp_servers.browser.bearer_token_env_var="COMPASS_CODEX_BROWSER_MCP_TOKEN"',
                    ]
                )
        argv.append("-")
        return argv

    @staticmethod
    def _process_group_exists(process: subprocess.Popen[bytes]) -> bool:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return False
        return True

    @classmethod
    def _terminate_group(cls, process: subprocess.Popen[bytes]) -> None:
        # The session can outlive its leader. Always signal the process group,
        # including after the direct child has already exited and been reaped.
        process.poll()
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + _PROCESS_TERMINATE_GRACE_SECONDS
        while cls._process_group_exists(process) and time.monotonic() < deadline:
            process.poll()
            time.sleep(0.05)
        if cls._process_group_exists(process):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.poll() is None:
            process.wait(timeout=5)

    @staticmethod
    def _parse_result(path: Path) -> AdapterResult:
        try:
            with path.open("rb") as handle:
                raw = handle.read(1_000_001)
            if len(raw) > 1_000_000:
                return AdapterResult(status="failed", summary="Codex structured result exceeded 1 MB", retryable=False)
            value = json.loads(raw)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return AdapterResult(status="failed", summary="Codex did not return a valid structured result", retryable=True)
        except (ValueError, OverflowError, RecursionError):
            return AdapterResult(status="failed", summary="Codex returned invalid JSON result data", retryable=False)
        if not isinstance(value, dict):
            return AdapterResult(status="failed", summary="Codex returned an invalid result object", retryable=True)
        status = value.get("status")
        summary = value.get("summary")
        details_wire = value.get("details")
        artifacts = value.get("artifacts")
        checkpoint_wire = value.get("checkpoint")
        retryable = value.get("retryable")
        artifacts_valid = isinstance(artifacts, list) and all(
            isinstance(artifact, dict)
            and set(artifact) == _ARTIFACT_KEYS
            and isinstance(artifact.get("kind"), str)
            and all(
                artifact[key] is None or isinstance(artifact[key], str)
                for key in _ARTIFACT_KEYS - {"kind"}
            )
            for artifact in artifacts
        )
        if not (
            set(value) == _RESULT_KEYS
            and isinstance(status, str)
            and status in {"succeeded", "waiting_for_user", "failed"}
            and isinstance(summary, str)
            and 1 <= len(summary) <= 2_000
            and summary.strip()
            and isinstance(details_wire, str)
            and artifacts_valid
            and isinstance(checkpoint_wire, str)
            and isinstance(retryable, bool)
        ):
            finding = (
                "non-boolean retryable flag"
                if "retryable" in value and not isinstance(retryable, bool)
                else "result outside the worker schema"
            )
            return AdapterResult(
                status="failed",
                summary=f"Codex returned a {finding}",
                retryable=False,
            )
        try:
            details = json.loads(details_wire)
            checkpoint = json.loads(checkpoint_wire)
            if not isinstance(details, dict):
                raise TypeError("details is not an object")
            if checkpoint is not None and not isinstance(checkpoint, dict):
                raise TypeError("checkpoint is not an object or null")
            # Python's decoder accepts NaN/Infinity and can overflow a valid
            # numeric literal (1e999) to infinity. Validate the decoded wire
            # strings before they cross into the app-facing result contract.
            encode_json_body({"details": details, "checkpoint": checkpoint})
        except (
            json.JSONDecodeError,
            TypeError,
            ValueError,
            OverflowError,
            RecursionError,
        ):
            return AdapterResult(
                status="failed",
                summary="Codex returned invalid JSON result data",
                retryable=False,
            )
        normalized_artifacts = [
            {key: item for key, item in artifact.items() if item is not None}
            for artifact in artifacts
        ]
        return AdapterResult(
            status=status,
            summary=summary,
            result={"details": details, "artifacts": normalized_artifacts},
            checkpoint=checkpoint,
            retryable=retryable,
        )

    def _run_record(
        self,
        task: Mapping[str, Any],
        events: _EventLog,
        elapsed: float,
        outcome: str,
        failure_category: str | None,
    ) -> dict[str, Any]:
        profile = self.profile_for(task.get("kind"))
        record: dict[str, Any] = {
            "executor": "codex",
            "codex_cli_version": self.cli_version,
            "model": profile.model or "codex-default",
            "reasoning_effort": profile.reasoning or "codex-default",
            "web_search": self._web_search_mode(task),
            "browser": self._uses_browser(task),
            "elapsed_seconds": round(elapsed, 1),
            "usage": dict(sorted(events.usage.items())),
            "tool_calls": dict(sorted(events.tool_calls.most_common(30))),
            "tool_failures": events.tool_failures,
            "outcome": outcome,
        }
        if failure_category:
            record["failure_category"] = failure_category
        return record

    def _finish(
        self,
        result: AdapterResult,
        task: Mapping[str, Any],
        events: _EventLog,
        started: float,
        failure_category: str | None = None,
    ) -> AdapterResult:
        record = self._run_record(
            task, events, time.monotonic() - started, result.status, failure_category
        )
        if result.status == "succeeded":
            result.result = {**result.result, "worker_run": record}
        else:
            result.checkpoint = {**(result.checkpoint or {}), "worker_run": record}
        return result

    def run(self, claim: TaskClaim, control: TaskControl) -> AdapterResult:
        try:
            self._validate_result_schema()
        except ValueError as error:
            return AdapterResult(status="failed", summary=str(error), retryable=False)
        timeout = self._task_timeout(claim.task)
        started = time.monotonic()
        events = _EventLog()
        with tempfile.TemporaryDirectory(prefix="compass-codex-") as directory:
            temp_dir = Path(directory)
            output_path = temp_dir / "result.json"
            prompt_path = temp_dir / "prompt.txt"
            workspace = self.workspace
            if workspace is None:
                workspace = temp_dir / "workspace"
                workspace.mkdir(mode=0o700)
            prompt_path.write_text(self._prompt(claim), encoding="utf-8")
            if control.cancelled:
                return AdapterResult(
                    status="failed",
                    summary=control.reason or "Task was cancelled",
                    retryable=False,
                )
            with prompt_path.open("rb") as prompt_file:
                argv = self._argv(output_path, claim.task, workspace)
                env = self._child_env(claim)
                if control.cancelled:
                    return AdapterResult(
                        status="failed",
                        summary=control.reason or "Task was cancelled",
                        retryable=False,
                    )
                process = subprocess.Popen(
                    argv,
                    stdin=prompt_file,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=workspace,
                    env=env,
                    start_new_session=True,
                )
                assert process.stdout is not None and process.stderr is not None
                stderr_tail = bytearray()
                event_bytes = 0
                selector = selectors.DefaultSelector()
                for stream in (process.stdout, process.stderr):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ)
                open_streams = 2
                try:
                    stop_reason: str | None = None
                    while True:
                        if control.cancelled:
                            stop_reason = control.reason or "Task was cancelled"
                            break
                        if time.monotonic() - started >= timeout:
                            stop_reason = f"Codex task exceeded its {int(timeout)} second time limit"
                            break
                        if open_streams:
                            ready = selector.select(timeout=0.05)
                        else:
                            ready = []
                            time.sleep(0.05)
                        for key, _mask in ready:
                            try:
                                chunk = os.read(key.fileobj.fileno(), 65_536)  # type: ignore[union-attr]
                            except BlockingIOError:
                                continue
                            if not chunk:
                                selector.unregister(key.fileobj)
                                open_streams -= 1
                                continue
                            if key.fileobj is process.stderr:
                                stderr_tail.extend(chunk)
                                del stderr_tail[:-_MAX_STDERR_TAIL_BYTES]
                                continue
                            event_bytes += len(chunk)
                            if event_bytes > _MAX_EVENT_OUTPUT_BYTES:
                                stop_reason = (
                                    "Codex event output exceeded its "
                                    f"{_MAX_EVENT_OUTPUT_BYTES // 1_000_000} MB limit"
                                )
                                break
                            events.feed(chunk)
                        if stop_reason is not None:
                            break
                        # A descendant may keep the pipes open after the CLI
                        # exits; the group is terminated below, so stop reading
                        # once the leader has exited and nothing is buffered.
                        if not ready and process.poll() is not None:
                            break
                    if stop_reason is not None:
                        category = (
                            None if control.cancelled
                            else "timeout" if stop_reason.endswith("time limit")
                            else "output_limit"
                        )
                        return self._finish(
                            AdapterResult(
                                status="failed",
                                summary=stop_reason,
                                retryable=not control.cancelled,
                            ),
                            claim.task,
                            events,
                            started,
                            category,
                        )
                    return_code = process.wait()
                finally:
                    selector.close()
                    self._terminate_group(process)
                    process.stdout.close()
                    process.stderr.close()
                events.finish()
            if return_code != 0:
                category = classify_codex_failure(
                    list(events.errors), stderr_tail.decode("utf-8", "replace")
                )
                if category in _FAILURE_OUTCOMES:
                    status, retryable, pause, summary = _FAILURE_OUTCOMES[category]
                    return self._finish(
                        AdapterResult(
                            status=status,
                            summary=summary,
                            retryable=retryable,
                            pause_worker=pause,
                        ),
                        claim.task,
                        events,
                        started,
                        category,
                    )
                return self._finish(
                    AdapterResult(
                        status="failed",
                        summary=f"Codex exited with status {return_code}",
                        retryable=True,
                    ),
                    claim.task,
                    events,
                    started,
                    "codex_exit",
                )
            parsed = self._parse_result(output_path)
            category = None
            if parsed.status == "failed" and not parsed.result:
                category = "invalid_result"
            return self._finish(parsed, claim.task, events, started, category)
