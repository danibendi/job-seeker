"""Codex CLI adapter for Compass worker tasks."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

from .client import TaskClaim, encode_json_body, join_app_path, normalize_app_url
from .runner import AdapterResult, TaskControl

REPO_ROOT = Path(__file__).resolve().parents[2]
_RESOURCES = Path(__file__).with_name("resources")
DEFAULT_SCHEMA = _RESOURCES / "task-result.schema.json"
DEFAULT_INSTRUCTIONS = _RESOURCES / "worker-instructions.md"
_MAX_EVENT_OUTPUT_BYTES = 10_000_000
_PROCESS_TERMINATE_GRACE_SECONDS = 5.0
_RESULT_KEYS = {"status", "summary", "details", "artifacts", "checkpoint", "retryable"}
_ARTIFACT_KEYS = {"kind", "id", "url", "label"}

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


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=True)


class CodexAdapter:
    def __init__(
        self,
        app_url: str,
        *,
        codex_bin: str = "codex",
        workspace: str | Path = REPO_ROOT,
        schema_path: str | Path = DEFAULT_SCHEMA,
        instructions_path: str | Path = DEFAULT_INSTRUCTIONS,
        timeout_seconds: float = 1_800,
        sandbox: str = "workspace-write",
        model: str | None = None,
        browser_mcp_url: str | None = None,
        browser_mcp_token: str | None = None,
        browser_mcp_enabled_tools: tuple[str, ...] = (),
        source_env: Mapping[str, str] | None = None,
    ):
        if sandbox not in {"read-only", "workspace-write", "danger-full-access"}:
            raise ValueError("Invalid Codex sandbox")
        self.app_url = normalize_app_url(app_url)
        self.codex_bin = codex_bin
        self.workspace = Path(workspace).resolve()
        self.schema_path = Path(schema_path).resolve()
        self.instructions_path = Path(instructions_path).resolve()
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self.sandbox = sandbox
        self.model = model
        self.browser_mcp_url = self._validate_browser_mcp(
            browser_mcp_url, browser_mcp_enabled_tools
        )
        self.browser_mcp_token = browser_mcp_token
        self.browser_mcp_enabled_tools = browser_mcp_enabled_tools
        self.source_env = dict(os.environ if source_env is None else source_env)

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

    def check(self) -> None:
        if not self.workspace.is_dir():
            raise ValueError(f"Codex workspace does not exist: {self.workspace}")
        for path in (self.schema_path, self.instructions_path):
            if not path.is_file():
                raise ValueError(f"Required Codex worker file does not exist: {path}")
        self._validate_result_schema()
        executable = self.codex_bin
        if os.path.sep in executable:
            candidate = Path(executable)
            if not candidate.is_absolute():
                candidate = self.workspace / candidate
            if not candidate.is_file() or not os.access(candidate, os.X_OK):
                raise ValueError(f"Codex executable is not runnable: {executable}")
        else:
            path_value = self.source_env.get("PATH", os.defpath)
            candidates = []
            for part in path_value.split(os.pathsep):
                directory = Path(part or ".")
                if not directory.is_absolute():
                    directory = self.workspace / directory
                candidates.append(directory / executable)
            if not any(
                candidate.is_file() and os.access(candidate, os.X_OK)
                for candidate in candidates
            ):
                raise ValueError(f"Codex executable was not found on PATH: {executable}")

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

    def _child_env(self, claim: TaskClaim) -> dict[str, str]:
        child = {name: self.source_env[name] for name in _SAFE_ENV_NAMES if name in self.source_env}
        child.setdefault("PATH", os.defpath)
        child["COMPASS_APP_URL"] = self.app_url.rstrip("/")
        child["COMPASS_TASK_ID"] = claim.id
        child["COMPASS_TASK_ATTEMPT"] = str(
            claim.task.get("attemptCount", claim.task.get("attempt_count", 1))
        )
        child["COMPASS_TASK_TOKEN"] = claim.claim_token
        if self.browser_mcp_token:
            child["COMPASS_CODEX_BROWSER_MCP_TOKEN"] = self.browser_mcp_token
        return child

    def _argv(self, output_path: Path) -> list[str]:
        mcp_url = join_app_path(self.app_url, "/api/worker/mcp")
        argv = [
            self.codex_bin,
            "exec",
            "--ignore-user-config",
            "--ephemeral",
            "--json",
            "--color",
            "never",
            "--sandbox",
            self.sandbox,
            "-c",
            'approval_policy="never"',
            "-c",
            f"mcp_servers.compass.url={_toml_string(mcp_url)}",
            "-c",
            'mcp_servers.compass.bearer_token_env_var="COMPASS_TASK_TOKEN"',
            "-c",
            "mcp_servers.compass.required=true",
            "-c",
            'mcp_servers.compass.default_tools_approval_mode="approve"',
            "--output-schema",
            str(self.schema_path),
            "--output-last-message",
            str(output_path),
            "--cd",
            str(self.workspace),
        ]
        if self.model:
            argv.extend(["--model", self.model])
        if self.browser_mcp_url:
            argv.extend(
                [
                    "-c",
                    f"mcp_servers.browser.url={_toml_string(self.browser_mcp_url)}",
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

    def run(self, claim: TaskClaim, control: TaskControl) -> AdapterResult:
        try:
            self._validate_result_schema()
        except ValueError as error:
            return AdapterResult(status="failed", summary=str(error), retryable=False)
        timeout = self._task_timeout(claim.task)
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="compass-codex-") as directory:
            temp_dir = Path(directory)
            output_path = temp_dir / "result.json"
            prompt_path = temp_dir / "prompt.txt"
            prompt_path.write_text(self._prompt(claim), encoding="utf-8")
            if control.cancelled:
                return AdapterResult(
                    status="failed",
                    summary=control.reason or "Task was cancelled",
                    retryable=False,
                )
            with prompt_path.open("rb") as prompt_file:
                argv = self._argv(output_path)
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
                    stderr=subprocess.STDOUT,
                    cwd=self.workspace,
                    env=env,
                    start_new_session=True,
                )
                assert process.stdout is not None
                os.set_blocking(process.stdout.fileno(), False)
                event_bytes = 0
                try:
                    stop_reason: str | None = None
                    while True:
                        if control.cancelled:
                            stop_reason = control.reason or "Task was cancelled"
                            break
                        if time.monotonic() - started >= timeout:
                            stop_reason = f"Codex task exceeded its {int(timeout)} second time limit"
                            break
                        try:
                            chunk = os.read(
                                process.stdout.fileno(),
                                min(65_536, _MAX_EVENT_OUTPUT_BYTES - event_bytes + 1),
                            )
                        except BlockingIOError:
                            chunk = None
                        if chunk:
                            event_bytes += len(chunk)
                            if event_bytes > _MAX_EVENT_OUTPUT_BYTES:
                                stop_reason = (
                                    "Codex event output exceeded its "
                                    f"{_MAX_EVENT_OUTPUT_BYTES // 1_000_000} MB limit"
                                )
                                break
                            continue
                        if process.poll() is not None:
                            break
                        time.sleep(0.05)
                    if stop_reason is not None:
                        return AdapterResult(
                            status="failed",
                            summary=stop_reason,
                            retryable=not control.cancelled,
                        )
                    return_code = process.wait()
                finally:
                    self._terminate_group(process)
                    process.stdout.close()
            if return_code != 0:
                return AdapterResult(
                    status="failed",
                    summary=f"Codex exited with status {return_code}",
                    retryable=True,
                )
            return self._parse_result(output_path)
