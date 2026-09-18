#!/usr/bin/env python3
"""Render and verify the Job Seeker reference stack without exposing secrets.

The default mode is a write-free plan. ``--write`` reads protected secret files
and creates a new mode-0700 output directory containing mode-0600/0700 files.
``--check-generated`` validates an existing rendered directory and prints only
names, modes, and status.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
TEMPLATES = ROOT / "templates"
REQUIRED_OUTPUTS = {
    "app.env": 0o600,
    "worker.env": 0o600,
    "scheduler.env": 0o600,
    "hermes-profile.yaml": 0o600,
    "hermes-root-config.yaml": 0o600,
    "owner-mcp-client.yaml": 0o600,
    "native-job.json": 0o600,
    "job_seeker_clock.py": 0o700,
    "job-seeker-clock.service": 0o600,
    "job-seeker-clock.timer": 0o600,
    "deploy-vercel.sh": 0o700,
    "cleanup-vercel.sh": 0o700,
    "manifest.json": 0o600,
}
SECRET_FIELDS = {
    "databasePooledFile",
    "databaseDirectFile",
    "authPasswordHashFile",
    "sessionSecretFile",
    "ownerMcpTokenFile",
    "workerTokenFile",
    "schedulerTokenFile",
}
TASK_KINDS = {"question", "search", "linkedin_evaluate"}


def arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "stack.example.json")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="create protected output files")
    mode.add_argument("--check-generated", type=Path, metavar="DIR")
    parser.add_argument("--output", type=Path, help="new directory used with --write")
    args = parser.parse_args(argv)
    if args.write != bool(args.output):
        parser.error("--write and --output must be supplied together")
    return args


def fail(message: str) -> None:
    raise ValueError(message)


def object_at(value: object, name: str) -> dict:
    if not isinstance(value, dict):
        fail(f"{name} must be an object")
    return value


def string_at(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\n" in value or "\r" in value:
        fail(f"{name} must be one nonempty line")
    return value.strip()


def absolute_path(value: object, name: str) -> str:
    result = string_at(value, name)
    if not Path(result).is_absolute():
        fail(f"{name} must be an absolute path")
    return result


def system_path(value: object, name: str) -> str:
    result = absolute_path(value, name)
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", result) or "//" in result or "/../" in result:
        fail(f"{name} contains characters unsafe for a systemd unit")
    return result


def https_url(value: object, name: str) -> str:
    result = string_at(value, name).rstrip("/")
    parsed = urlparse(result)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        fail(f"{name} must be a credential-free HTTPS origin")
    return result


def validate(config: object) -> tuple[dict, list[str]]:
    config = object_at(config, "configuration")
    if config.get("schemaVersion") != 1:
        fail("schemaVersion must be 1")
    project = string_at(config.get("projectName"), "projectName")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?", project):
        fail("projectName must be a lowercase Vercel project name")
    config["sourceRoot"] = absolute_path(config.get("sourceRoot"), "sourceRoot")
    config["sourceRevision"] = string_at(config.get("sourceRevision"), "sourceRevision")
    if not re.fullmatch(r"[a-f0-9]{40}", config["sourceRevision"]):
        fail("sourceRevision must be a full 40-character lowercase Git SHA")
    config["appUrl"] = https_url(config.get("appUrl"), "appUrl")

    vercel = object_at(config.get("vercel"), "vercel")
    vercel["functionRegion"] = string_at(vercel.get("functionRegion"), "vercel.functionRegion")
    if not re.fullmatch(r"[a-z0-9]{3,12}", vercel["functionRegion"]) or vercel.get("nodeVersion") != "22.x":
        fail("vercel.functionRegion must be a valid region slug and nodeVersion must be 22.x")
    vercel["accountId"] = string_at(vercel.get("accountId"), "vercel.accountId")
    vercel["scope"] = string_at(vercel.get("scope"), "vercel.scope")
    if not re.fullmatch(r"team_[A-Za-z0-9]{8,}|[A-Za-z0-9_-]{8,}", vercel["accountId"]):
        fail("vercel.accountId has an invalid format")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{1,99}", vercel["scope"]):
        fail("vercel.scope has an invalid format")

    secrets = object_at(config.get("secrets"), "secrets")
    missing = sorted(SECRET_FIELDS - secrets.keys())
    if missing:
        fail("missing secret file fields: " + ", ".join(missing))
    for name in SECRET_FIELDS:
        secrets[name] = absolute_path(secrets[name], f"secrets.{name}")

    worker = object_at(config.get("worker"), "worker")
    worker_id = string_at(worker.get("id"), "worker.id")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", worker_id):
        fail("worker.id has an invalid format")
    for name in ("pythonExecutable", "clockScript", "environmentFile", "schedulerEnvironmentFile", "workerTokenFile", "schedulerTokenFile", "lockFile", "serviceHome"):
        worker[name] = system_path(worker.get(name), f"worker.{name}")
    service_home = Path(worker["serviceHome"])
    lock_directory = Path(worker["lockFile"]).parent
    if service_home.parent != Path("/var/lib") or lock_directory.parent != Path("/run"):
        fail("worker.serviceHome and lockFile must use /var/lib/NAME and /run/NAME")
    if service_home.name != lock_directory.name:
        fail("worker.serviceHome and lockFile must use the same service name")
    secret_root = service_home / "secrets"
    if Path(worker["workerTokenFile"]).parent != secret_root or Path(worker["schedulerTokenFile"]).parent != secret_root:
        fail("runtime worker and scheduler token files must use serviceHome/secrets")
    if worker["workerTokenFile"] == worker["schedulerTokenFile"]:
        fail("runtime worker and scheduler token file paths must differ")
    for name in ("serviceUser", "serviceGroup"):
        worker[name] = string_at(worker.get(name), f"worker.{name}")
        if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", worker[name]):
            fail(f"worker.{name} must be a system account name")
    timeout = worker.get("taskTimeoutSeconds")
    if type(timeout) is not int or not 60 <= timeout <= 86_400:
        fail("worker.taskTimeoutSeconds must be an integer from 60 through 86400")
    drain = worker.get("queueDrainSeconds")
    if type(drain) is not int or not 60 <= drain <= 86_400:
        fail("worker.queueDrainSeconds must be an integer from 60 through 86400")
    kinds = worker.get("taskKinds")
    if not isinstance(kinds, list) or not kinds or len(kinds) != len(set(kinds)) or any(kind not in TASK_KINDS for kind in kinds):
        fail("worker.taskKinds must be a unique nonempty list of supported task kinds")

    hermes = object_at(config.get("hermes"), "hermes")
    for name in ("runtimeRoot", "executable", "kanbanHome", "profilesDirectory", "rootConfig"):
        hermes[name] = system_path(hermes.get(name), f"hermes.{name}")
    runtime = Path(hermes["runtimeRoot"])
    if Path(hermes["executable"]) != runtime / "venv" / "bin" / "hermes":
        fail("hermes.executable must be runtimeRoot/venv/bin/hermes")
    hermes_home = Path(worker["serviceHome"]) / ".hermes"
    if Path(hermes["profilesDirectory"]) != hermes_home / "profiles" or Path(hermes["rootConfig"]) != hermes_home / "config.yaml":
        fail("Hermes profile and root config must use serviceHome/.hermes; /etc/hermes/config.yaml is unsupported")
    if Path(hermes["kanbanHome"]) != hermes_home / "kanban":
        fail("hermes.kanbanHome must use serviceHome/.hermes/kanban")
    for name in ("versionBaseline", "profile", "board", "tenant", "provider", "model", "reasoning",
                 "evaluationProvider", "evaluationModel", "evaluationReasoning"):
        hermes[name] = string_at(hermes.get(name), f"hermes.{name}")
    if hermes["profile"].endswith("-staging"):
        fail("hermes.profile must be the real profile, not the deliberately absent staging profile")

    scheduler = object_at(config.get("scheduler"), "scheduler")
    interval = scheduler.get("intervalMinutes")
    if type(interval) is not int or interval < 1 or interval > 59:
        fail("scheduler.intervalMinutes must be an integer from 1 through 59")
    scheduler["nativeScriptName"] = string_at(scheduler.get("nativeScriptName"), "scheduler.nativeScriptName")
    if Path(scheduler["nativeScriptName"]).name != scheduler["nativeScriptName"]:
        fail("scheduler.nativeScriptName must be a file name")

    linkedin = object_at(config.get("linkedin"), "linkedin")
    if type(linkedin.get("enabled")) is not bool or type(linkedin.get("blockMedia")) is not bool:
        fail("linkedin.enabled and linkedin.blockMedia must be booleans")
    linkedin["browserUseApiKeyFile"] = absolute_path(linkedin.get("browserUseApiKeyFile"), "linkedin.browserUseApiKeyFile")
    linkedin["nodeExecutable"] = absolute_path(linkedin.get("nodeExecutable"), "linkedin.nodeExecutable")
    for name in ("profileId", "expectedAccountName", "proxyCountry"):
        linkedin[name] = string_at(linkedin.get(name), f"linkedin.{name}")
    if linkedin["proxyCountry"] != "direct" and not re.fullmatch(r"[a-z]{2}", linkedin["proxyCountry"]):
        fail("linkedin.proxyCountry must be direct or a two-letter country code")

    warnings = [
        "The native job is rendered disabled; enable it only after real task-flow verification.",
        "The clock imports adapter classes from the pinned worker package; re-run its offline checks before upgrading the package.",
    ]
    if not linkedin["enabled"]:
        warnings.append("LinkedIn browser collection is intentionally disabled.")
    return config, warnings


def load_config(path: Path) -> tuple[dict, list[str]]:
    if path.is_symlink() or not path.is_file():
        fail("configuration must be a regular, non-symbolic file")
    return validate(json.loads(path.read_text(encoding="utf-8")))


def protected_secret(path_value: str, label: str) -> str:
    path = Path(path_value)
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_mode & 0o077:
        fail(f"{label} must be a regular, non-symbolic, owner-only file")
    value = path.read_text(encoding="utf-8").rstrip("\r\n")
    if not value or "\n" in value or "\r" in value:
        fail(f"{label} must contain exactly one nonempty line")
    return value


def shell_value(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def env_text(values: dict[str, str], heading: str) -> str:
    lines = [f"# {heading}"]
    lines.extend(f"{name}={shell_value(value)}" for name, value in values.items())
    return "\n".join(lines) + "\n"


def render_template(name: str, replacements: dict[str, str]) -> str:
    text = (TEMPLATES / name).read_text(encoding="utf-8")
    for key, value in replacements.items():
        text = text.replace(f"@@{key}@@", value)
    unresolved = sorted(set(re.findall(r"@@[A-Z0-9_]+@@", text)))
    if unresolved:
        fail(f"unresolved template values in {name}: {', '.join(unresolved)}")
    return text


def render(config: dict, output: Path, warnings: list[str]) -> dict:
    if output.exists() or output.is_symlink():
        fail("output path already exists; choose a new directory")
    output.mkdir(mode=0o700, parents=True)
    os.chmod(output, 0o700)
    try:
        secret_paths = config["secrets"]
        secret_values = {name: protected_secret(secret_paths[name], f"secrets.{name}") for name in SECRET_FIELDS}
        auth_hash = secret_values["authPasswordHashFile"]
        if not re.fullmatch(r"\$2[aby]\$\d{2}\$.{53}", auth_hash):
            fail("auth password hash is not a bcrypt hash")
        for name in ("sessionSecretFile", "ownerMcpTokenFile", "workerTokenFile", "schedulerTokenFile"):
            if not re.fullmatch(r"\S{32,512}", secret_values[name]):
                fail(f"secrets.{name} must contain 32-512 non-whitespace characters")
        authorities = [secret_values[name] for name in ("ownerMcpTokenFile", "workerTokenFile", "schedulerTokenFile")]
        if len(set(authorities)) != len(authorities):
            fail("owner, worker, and scheduler credentials must be distinct")
        pooled = urlparse(secret_values["databasePooledFile"])
        direct = urlparse(secret_values["databaseDirectFile"])
        if pooled.scheme not in {"postgres", "postgresql"} or not pooled.hostname or "-pooler" not in pooled.hostname:
            fail("databasePooledFile must contain a Neon pooled PostgreSQL URL")
        if direct.scheme not in {"postgres", "postgresql"} or not direct.hostname or "-pooler" in direct.hostname:
            fail("databaseDirectFile must contain a direct PostgreSQL URL")
        pooled_direct_host = pooled.hostname.replace("-pooler.", ".", 1)
        if (
            pooled_direct_host != direct.hostname
            or pooled.username != direct.username
            or pooled.password != direct.password
            or pooled.port != direct.port
            or pooled.path != direct.path
        ):
            fail("pooled and direct database URLs must identify the same Neon endpoint, role, and database")

        app_values = {
            "DATABASE_URL": secret_values["databasePooledFile"],
            "DATABASE_URL_UNPOOLED": secret_values["databaseDirectFile"],
            "AUTH_PASSWORD_HASH": auth_hash,
            "SESSION_SECRET": secret_values["sessionSecretFile"],
            "OWNER_MCP_TOKEN": secret_values["ownerMcpTokenFile"],
            "COMPASS_WORKERS_JSON": json.dumps([{
                "id": config["worker"]["id"],
                "executor": "hermes",
                "token": secret_values["workerTokenFile"],
            }], separators=(",", ":")),
            "COMPASS_SCHEDULER_TOKEN": secret_values["schedulerTokenFile"],
            "JOB_SEEKER_SOURCE_REVISION": config["sourceRevision"],
        }
        worker_values = {
            "JOB_SEEKER_APP_URL": config["appUrl"],
            "COMPASS_WORKER_TOKEN_FILE": config["worker"]["workerTokenFile"],
            "COMPASS_WORKER_EXECUTOR": "hermes",
            "COMPASS_TASK_TIMEOUT_SECONDS": str(config["worker"]["taskTimeoutSeconds"]),
            "COMPASS_HERMES_BIN": config["hermes"]["executable"],
            "COMPASS_HERMES_RUNTIME_ROOT": config["hermes"]["runtimeRoot"],
            "HERMES_HOME": str(Path(config["hermes"]["profilesDirectory"]).parent),
            "HERMES_KANBAN_HOME": config["hermes"]["kanbanHome"],
            "COMPASS_HERMES_BOARD": config["hermes"]["board"],
            "COMPASS_HERMES_TENANT": config["hermes"]["tenant"],
            "COMPASS_HERMES_PROFILE": config["hermes"]["profile"],
            "COMPASS_HERMES_MODEL": config["hermes"]["model"],
            "COMPASS_HERMES_PROVIDER": config["hermes"]["provider"],
            "COMPASS_HERMES_REASONING": config["hermes"]["reasoning"],
            "COMPASS_HERMES_EVALUATION_MODEL": config["hermes"]["evaluationModel"],
            "COMPASS_HERMES_EVALUATION_PROVIDER": config["hermes"]["evaluationProvider"],
            "COMPASS_HERMES_EVALUATION_REASONING": config["hermes"]["evaluationReasoning"],
            "COMPASS_HERMES_TASK_KINDS": ",".join(config["worker"]["taskKinds"]),
        }
        if config["linkedin"]["enabled"]:
            browser_key = protected_secret(config["linkedin"]["browserUseApiKeyFile"], "linkedin.browserUseApiKeyFile")
            if not re.fullmatch(r"\S{8,512}", browser_key):
                fail("linkedin.browserUseApiKeyFile must contain one non-whitespace credential")
            worker_values.update({
                "BROWSER_USE_API_KEY": browser_key,
                "COMPASS_LINKEDIN_PROFILE_ID": config["linkedin"]["profileId"],
                "COMPASS_LINKEDIN_EXPECTED_NAME": config["linkedin"]["expectedAccountName"],
                "COMPASS_LINKEDIN_PROXY_COUNTRY": config["linkedin"]["proxyCountry"],
                "COMPASS_LINKEDIN_BLOCK_MEDIA": "1" if config["linkedin"]["blockMedia"] else "0",
                "COMPASS_NODE_BIN": config["linkedin"]["nodeExecutable"],
            })
        scheduler_values = {
            "JOB_SEEKER_APP_URL": config["appUrl"],
            "COMPASS_SCHEDULER_TOKEN_FILE": config["worker"]["schedulerTokenFile"],
        }

        files = {
            "app.env": env_text(app_values, "Resolved application values. Keep owner-only."),
            "worker.env": env_text(worker_values, "Hermes worker process configuration. Keep owner-only."),
            "scheduler.env": env_text(scheduler_values, "Scheduler-only authority. Keep owner-only."),
            "hermes-profile.yaml": render_template("hermes-profile.yaml", {
                "MODEL": json.dumps(config["hermes"]["model"]),
                "PROVIDER": json.dumps(config["hermes"]["provider"]),
            }),
            "hermes-root-config.yaml": render_template("hermes-root-config.yaml", {}),
            "owner-mcp-client.yaml": render_template("owner-mcp-client.yaml", {
                "APP_URL": config["appUrl"],
            }),
            "native-job.json": render_template("native-job.json", {
                "JOB_ID": hashlib.sha256((config["projectName"] + ":clock").encode()).hexdigest()[:12],
                "SCRIPT_NAME": config["scheduler"]["nativeScriptName"],
                "INTERVAL_MINUTES": str(config["scheduler"]["intervalMinutes"]),
            }),
            "job_seeker_clock.py": render_template("job_seeker_clock.py", {
                "WORKER_ENV_FILE": repr(config["worker"]["environmentFile"]),
                "SCHEDULER_ENV_FILE": repr(config["worker"]["schedulerEnvironmentFile"]),
                "LOCK_FILE": repr(config["worker"]["lockFile"]),
                "TASK_TIMEOUT_SECONDS": str(config["worker"]["taskTimeoutSeconds"]),
                "QUEUE_DRAIN_SECONDS": str(config["worker"]["queueDrainSeconds"]),
                "WORKER_BIN_DIRECTORY": repr(str(Path(config["worker"]["pythonExecutable"]).parent)),
            }),
            "job-seeker-clock.service": render_template("job-seeker-clock.service", {
                "SERVICE_USER": config["worker"]["serviceUser"],
                "SERVICE_GROUP": config["worker"]["serviceGroup"],
                "PYTHON_EXECUTABLE": config["worker"]["pythonExecutable"],
                "CLOCK_SCRIPT": config["worker"]["clockScript"],
                "LOCK_DIRECTORY": str(Path(config["worker"]["lockFile"]).parent),
                "SERVICE_HOME": config["worker"]["serviceHome"],
                "RUNTIME_DIRECTORY_NAME": Path(config["worker"]["lockFile"]).parent.name,
                "STATE_DIRECTORY_NAME": Path(config["worker"]["serviceHome"]).name,
                "SERVICE_TIMEOUT_SECONDS": str(config["worker"]["taskTimeoutSeconds"] + config["worker"]["queueDrainSeconds"] + 600),
            }),
            "job-seeker-clock.timer": render_template("job-seeker-clock.timer", {
                "INTERVAL_MINUTES": str(config["scheduler"]["intervalMinutes"]),
            }),
            "deploy-vercel.sh": render_template("deploy-vercel.sh", {
                "PROJECT_NAME": shell_value(config["projectName"]),
                "SOURCE_ROOT": shell_value(config["sourceRoot"]),
                "ACCOUNT_ID": shell_value(config["vercel"]["accountId"]),
                "SCOPE": shell_value(config["vercel"]["scope"]),
                "APP_URL": shell_value(config["appUrl"]),
                "SOURCE_REVISION": shell_value(config["sourceRevision"]),
                "FUNCTION_REGION": shell_value(config["vercel"]["functionRegion"]),
            }),
            "cleanup-vercel.sh": render_template("cleanup-vercel.sh", {
                "PROJECT_NAME": shell_value(config["projectName"]),
                "ACCOUNT_ID": shell_value(config["vercel"]["accountId"]),
            }),
        }
        manifest = {
            "schemaVersion": 1,
            "projectName": config["projectName"],
            "appUrl": config["appUrl"],
            "hermesVersionBaseline": config["hermes"]["versionBaseline"],
            "protocolVersion": 1,
            "workerPackageVersion": "0.1.0",
            "files": sorted([*files, "manifest.json"]),
            "secretValuesIncluded": ["app.env"] + (["worker.env"] if config["linkedin"]["enabled"] else []),
            "nativeJobEnabled": False,
            "warnings": warnings,
        }
        files["manifest.json"] = json.dumps(manifest, indent=2) + "\n"
        for name, text in files.items():
            path = output / name
            path.write_text(text, encoding="utf-8")
            os.chmod(path, REQUIRED_OUTPUTS[name])
        return check_generated(output)
    except Exception:
        # Leave the protected directory for diagnosis, but never print content.
        raise


def variable_names(path: Path) -> set[str]:
    names = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            names.add(line.split("=", 1)[0])
    return names


def check_generated(directory: Path) -> dict:
    if directory.is_symlink() or not directory.is_dir() or directory.stat().st_mode & 0o077:
        fail("generated directory must be a non-symbolic owner-only directory")
    results = []
    for name, required_mode in REQUIRED_OUTPUTS.items():
        path = directory / name
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode)
        passed = path.is_file() and not path.is_symlink() and mode == required_mode
        results.append({"file": name, "mode": oct(mode), "status": "passed" if passed else "failed"})
        if not passed:
            fail(f"unsafe generated file: {name}")
    app_names = variable_names(directory / "app.env")
    worker_names = variable_names(directory / "worker.env")
    scheduler_names = variable_names(directory / "scheduler.env")
    required_app = {"DATABASE_URL", "DATABASE_URL_UNPOOLED", "AUTH_PASSWORD_HASH", "SESSION_SECRET", "OWNER_MCP_TOKEN", "COMPASS_WORKERS_JSON", "COMPASS_SCHEDULER_TOKEN", "JOB_SEEKER_SOURCE_REVISION"}
    required_worker = {"JOB_SEEKER_APP_URL", "COMPASS_WORKER_TOKEN_FILE", "COMPASS_WORKER_EXECUTOR", "COMPASS_HERMES_BIN", "COMPASS_HERMES_RUNTIME_ROOT", "COMPASS_HERMES_PROFILE", "COMPASS_HERMES_TASK_KINDS"}
    if not required_app <= app_names or not required_worker <= worker_names or scheduler_names != {"JOB_SEEKER_APP_URL", "COMPASS_SCHEDULER_TOKEN_FILE"}:
        fail("generated environment files omit required authority or runtime names")
    profile = (directory / "hermes-profile.yaml").read_text(encoding="utf-8")
    root = (directory / "hermes-root-config.yaml").read_text(encoding="utf-8")
    owner = (directory / "owner-mcp-client.yaml").read_text(encoding="utf-8")
    if "${COMPASS_TASK_TOKEN}" not in profile or "${COMPASS_APP_URL}/api/worker/mcp" not in profile:
        fail("generated profile does not use task-scoped MCP authority")
    if "dispatch_in_gateway: false" not in profile or "dispatch_in_gateway: false" not in root:
        fail("generated Hermes configuration does not disable gateway dispatch")
    if "${JOB_SEEKER_OWNER_MCP_TOKEN}" not in owner or "/api/mcp" not in owner or "/api/worker/mcp" in owner:
        fail("owner MCP client does not use the separate owner authority")
    job = json.loads((directory / "native-job.json").read_text(encoding="utf-8"))
    if job.get("no_agent") is not True or job.get("enabled") is not False or job.get("deliver") != "local":
        fail("native job must be a disabled, local, script-only example")
    service = (directory / "job-seeker-clock.service").read_text(encoding="utf-8")
    timer = (directory / "job-seeker-clock.timer").read_text(encoding="utf-8")
    if "ExecStart=/" not in service or "/bin/python /" not in service or "StateDirectory=" not in service or "NoNewPrivileges=true" not in service or "OnCalendar=*" not in timer:
        fail("generated systemd fallback is incomplete")
    for path in directory.iterdir():
        if path.is_file() and "@@" in path.read_text(encoding="utf-8"):
            fail(f"generated file contains an unresolved template marker: {path.name}")
    return {
        "status": "passed",
        "mode": "generated-check",
        "directory": str(directory),
        "files": results,
        "secretValuesPrinted": False,
    }


def main(argv: list[str] | None = None) -> int:
    args = arguments(sys.argv[1:] if argv is None else argv)
    if args.check_generated:
        report = check_generated(args.check_generated.resolve())
    else:
        config, warnings = load_config(args.config.resolve())
        if args.write:
            report = render(config, args.output.resolve(), warnings)
            report["mode"] = "write"
            report["warnings"] = warnings
        else:
            report = {
                "status": "passed",
                "mode": "dry-run",
                "config": str(args.config.resolve()),
                "wouldWrite": sorted(REQUIRED_OUTPUTS),
                "secretFilesRead": False,
                "warnings": warnings,
            }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "failed", "error": str(error), "secretValuesPrinted": False}), file=sys.stderr)
        raise SystemExit(1)
