#!/usr/bin/python3 -I
"""Trusted exec gate for Hermes 0.21's supported HERMES_BIN override.

The native dispatcher sets the actual card/board/profile before this program
starts. Check those values before loading Hermes, its profile, MCP or any model.
No Hermes imports, secret persistence or fallback execution. Bounded dotenv
checks reject native credential reload paths before the model starts.
"""

from __future__ import annotations

import os
import math
from pathlib import Path
import sys
import time


# Native dispatch starts a second Hermes CLI, which loads the owner's root
# dotenv and secret sources before spawning us. Rebuild the environment here,
# after native card binding, rather than trusting the adapter's earlier scrub.
# Provider OAuth remains in the runtime's supported private auth store.
MODEL_ENV_NAMES = frozenset({
    "HOME", "PATH", "LANG", "LC_ALL", "SSL_CERT_DIR", "SSL_CERT_FILE", "TERM",
    "TMPDIR", "TZ", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "HERMES_HOME", "HERMES_PROFILE", "HERMES_KANBAN_HOME", "HERMES_TENANT", "HERMES_MANAGED_DIR",
    "HERMES_KANBAN_TASK", "HERMES_KANBAN_BOARD", "HERMES_KANBAN_RUN_ID",
    "HERMES_KANBAN_CLAIM_LOCK", "HERMES_KANBAN_WORKSPACE", "HERMES_KANBAN_DB",
    "HERMES_KANBAN_WORKSPACES_ROOT", "HERMES_KANBAN_BRANCH", "HERMES_SESSION_SOURCE",
    "TERMINAL_CWD", "TERMINAL_TIMEOUT", "TERMINAL_MAX_FOREGROUND_TIMEOUT",
    "COMPASS_APP_URL", "COMPASS_TASK_ID", "COMPASS_TASK_ATTEMPT", "COMPASS_TASK_TOKEN",
})


def verify_runtime_environment_files(runtime_root: str, environment: dict[str, str]) -> bool:
    """Fail closed on native dotenv fallbacks; never import owner config here.

    The pinned CLI has no supported skip-dotenv option. A dedicated profile
    with secret sources disabled plus empty/absent native fallback files uses
    the normal unmodified runtime safely. Managed configuration is rejected
    for this restricted worker until separately reviewed; it is never bypassed.
    """
    try:
        root = Path(runtime_root)
        home = Path(environment.get("HERMES_HOME", ""))
        if not runtime_root or not root.is_absolute() or not home.is_absolute() or not home.is_dir():
            return False
        if not (root / "hermes_cli" / "main.py").is_file() or not (root / "cli.py").is_file():
            return False
        managed_override = environment.get("HERMES_MANAGED_DIR", "").strip()
        managed = Path(managed_override) if managed_override else Path("/etc/hermes")
        if not managed.is_absolute() or (managed / "config.yaml").exists():
            return False
        for path in (root / ".env", home / ".env", home / ".op.env", managed / ".env"):
            if path.is_symlink():
                return False
            if not path.exists():
                continue
            if not path.is_file() or path.stat().st_size > 64_000:
                return False
            if any(line.strip() and not line.lstrip().startswith("#")
                   for line in path.read_text(encoding="utf-8").splitlines()):
                return False
        return True
    except (OSError, ValueError):
        return False


def main() -> int:
    env = dict(os.environ)
    expected_card = env.pop("COMPASS_HERMES_EXPECTED_CARD", "")
    expected_board = env.pop("COMPASS_HERMES_EXPECTED_BOARD", "")
    expected_profile = env.pop("COMPASS_HERMES_EXPECTED_PROFILE", "")
    executable = env.pop("COMPASS_HERMES_REAL_BIN", "")
    runtime_root = env.pop("COMPASS_HERMES_RUNTIME_ROOT", "")
    reasoning = env.pop("COMPASS_HERMES_REASONING", "")
    try:
        lease_deadline = float(env.pop("COMPASS_HERMES_LEASE_DEADLINE", ""))
    except ValueError:
        lease_deadline = float("nan")
    env.pop("HERMES_BIN", None)
    argv = sys.argv[1:]
    option_args = argv[4:-3]
    # Reasoning belongs to the trusted attempt, not mutable native card data.
    # The pinned create parser has no reasoning option; inject it only at exec.
    allowed_options = {"-m", "--provider", "--toolsets"}
    options_valid = len(option_args) % 2 == 0
    seen: set[str] = set()
    for index in range(0, len(option_args) - 1, 2):
        name, value = option_args[index:index + 2]
        if name not in allowed_options or name in seen or not value or value.startswith("-"):
            options_valid = False
        seen.add(name)
    # Match both the dispatcher's injected identity and fixed invocation shape.
    # Fail closed even if one representation changes or is missing. Card text,
    # metadata and comments are never used to establish identity here.
    valid = (
        bool(expected_card and expected_board and expected_profile)
        and math.isfinite(lease_deadline)
        and time.monotonic() < lease_deadline
        and env.get("HERMES_KANBAN_TASK") == expected_card
        and env.get("HERMES_KANBAN_BOARD") == expected_board
        and env.get("HERMES_PROFILE") == expected_profile
        and bool(env.get("HERMES_KANBAN_RUN_ID"))
        and bool(env.get("HERMES_KANBAN_CLAIM_LOCK"))
        and bool(env.get("COMPASS_TASK_TOKEN"))
        and bool(env.get("COMPASS_TASK_ID"))
        and bool(env.get("COMPASS_TASK_ATTEMPT"))
        and argv[:4] == ["-p", expected_profile, "--cli", "--accept-hooks"]
        and argv[-3:] == ["chat", "-q", f"work kanban task {expected_card}"]
        and options_valid
        and reasoning in {"", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
        and os.path.isabs(executable)
        and os.access(executable, os.X_OK)
        and Path(executable).resolve() != Path(__file__).resolve()
    )
    if not valid or time.monotonic() >= lease_deadline:
        # A mismatched native candidate must never reach model/profile startup.
        # Do not render argv, routing fields, profile data or environment.
        print("Compass Hermes launch refused: native dispatch identity mismatch", file=sys.stderr)
        return 78
    if not verify_runtime_environment_files(runtime_root, env):
        print("Compass Hermes launch refused: native runtime environment isolation unavailable", file=sys.stderr)
        return 78
    env = {name: value for name, value in env.items() if name in MODEL_ENV_NAMES}
    if reasoning:
        argv = [*argv[:-3], "--reasoning", reasoning, *argv[-3:]]
    try:
        os.execve(executable, [executable, *argv], env)
    except OSError:
        print("Compass Hermes launch refused: executable unavailable", file=sys.stderr)
        return 78
    return 78


if __name__ == "__main__":
    raise SystemExit(main())
