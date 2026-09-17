"""Small, dependency-free client for the Compass worker API."""

from __future__ import annotations

import json
from dataclasses import dataclass
from http.client import HTTPException, IncompleteRead
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


class ApiError(RuntimeError):
    """A sanitized worker API failure."""

    def __init__(self, message: str, *, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class _NoRedirectHandler(HTTPRedirectHandler):
    """Fail closed so bearer credentials are never replayed after a redirect."""

    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str):
        return None


def normalize_app_url(value: str) -> str:
    value = value.strip().rstrip("/") + "/"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("COMPASS_APP_URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("COMPASS_APP_URL must not contain credentials, a query, or a fragment")
    try:
        parsed.port
    except ValueError:
        raise ValueError("COMPASS_APP_URL must contain a valid port") from None
    if parsed.netloc.endswith(":"):
        raise ValueError("COMPASS_APP_URL must contain a valid port")
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" and host not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("COMPASS_APP_URL must use HTTPS except on loopback")
    return value


def join_app_path(base_url: str, path: str) -> str:
    """Join an app-relative route while preserving a mounted base path."""

    return urljoin(base_url, path.lstrip("/"))


def encode_json_body(body: dict[str, Any]) -> bytes:
    """Serialize a request exactly as the HTTP client will send it."""

    return json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8")


@dataclass(frozen=True)
class TaskClaim:
    task: dict[str, Any]
    claim_token: str
    lease_expires_at: str | None
    heartbeat_interval_seconds: float

    @property
    def id(self) -> str:
        return str(self.task["id"])

    @property
    def executor(self) -> str:
        return str(self.task.get("executor", ""))

    @classmethod
    def from_response(cls, value: dict[str, Any]) -> TaskClaim | None:
        task = value.get("task")
        if task is None:
            return None
        if not isinstance(task, dict) or not task.get("id"):
            raise ApiError("Claim response did not contain a valid task")
        token = value.get("claim_token")
        if not isinstance(token, str) or not token:
            raise ApiError("Claim response did not contain a claim token")
        interval = value.get("heartbeat_interval_seconds", 30)
        if not isinstance(interval, (int, float)) or isinstance(interval, bool):
            raise ApiError("Claim response contained an invalid heartbeat interval")
        return cls(
            task=task,
            claim_token=token,
            lease_expires_at=value.get("lease_expires_at"),
            heartbeat_interval_seconds=max(1.0, min(float(interval), 300.0)),
        )


class CompassClient:
    def __init__(self, base_url: str, token: str, *, timeout_seconds: float = 30,
                 task_kinds: tuple[str, ...] | None = None):
        self.base_url = normalize_app_url(base_url)
        if not token:
            raise ValueError("Compass bearer token is required")
        self._token = token
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 120.0))
        if task_kinds is not None and (not task_kinds or any(kind not in {"search", "linkedin_evaluate", "question"} for kind in task_kinds)):
            raise ValueError("Invalid worker task kind filter")
        self.task_kinds = task_kinds
        self._opener = build_opener(_NoRedirectHandler())

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = None if body is None else encode_json_body(body)
        request = Request(
            join_app_path(self.base_url, path),
            data=payload,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "User-Agent": "compass-worker/1",
            },
        )
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                raw = response.read(1_000_001)
                if len(raw) > 1_000_000:
                    raise ApiError("Compass API response exceeded 1 MB")
                if not raw:
                    return {}
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise ApiError("Compass API returned a non-object JSON response")
                return value
        except HTTPError as error:
            message = f"Compass API returned HTTP {error.code}"
            try:
                try:
                    value = json.loads(error.read(64_000))
                    detail = value.get("error") if isinstance(value, dict) else None
                    if isinstance(detail, str) and detail:
                        message = detail[:500]
                except (HTTPException, OSError, json.JSONDecodeError, UnicodeDecodeError):
                    pass
            finally:
                error.close()
            raise ApiError(
                message,
                status=error.code,
                retryable=error.code in {408, 425, 429} or error.code >= 500,
            ) from None
        except IncompleteRead:
            raise ApiError("Compass API returned an incomplete response", retryable=True) from None
        except HTTPException:
            raise ApiError("Compass API returned a malformed HTTP response", retryable=True) from None
        except OSError as error:
            reason = getattr(error, "reason", None)
            reason_name = type(reason).__name__ if reason is not None else type(error).__name__
            raise ApiError(f"Compass API connection failed ({reason_name})", retryable=True) from None
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError("Compass API returned invalid JSON") from None

    def claim(self) -> TaskClaim | None:
        return TaskClaim.from_response(self._request("POST", "/api/worker/tasks/claim",
            {"kinds": list(self.task_kinds)} if self.task_kinds else {}))

    def renew(self, task_id: str, claim_token: str) -> dict[str, Any]:
        return self._request(
            "POST", f"/api/worker/tasks/{quote(task_id, safe='')}/renew", {"claim_token": claim_token}
        )

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/worker/tasks/{quote(task_id, safe='')}")

    def progress(
        self,
        task_id: str,
        claim_token: str,
        *,
        checkpoint: dict[str, Any] | None = None,
        external_ref: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"claim_token": claim_token}
        if checkpoint is not None:
            body["checkpoint"] = checkpoint
        if external_ref is not None:
            body["external_ref"] = external_ref
        if message is not None:
            body["message"] = message
        return self._request("POST", f"/api/worker/tasks/{quote(task_id, safe='')}/progress", body)

    def complete(self, task_id: str, claim_token: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/worker/tasks/{quote(task_id, safe='')}/complete",
            {"claim_token": claim_token, "result": result},
        )

    def fail(
        self,
        task_id: str,
        claim_token: str,
        *,
        error: str,
        retryable: bool = False,
        waiting_for_user: bool = False,
        checkpoint: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "claim_token": claim_token,
            "error": error[:2_000],
            "retryable": retryable,
            "waiting_for_user": waiting_for_user,
        }
        if checkpoint is not None:
            body["checkpoint"] = checkpoint
        return self._request("POST", f"/api/worker/tasks/{quote(task_id, safe='')}/fail", body)

    def schedule_tick(self) -> dict[str, Any]:
        return self._request("POST", "/api/worker/schedule/tick", {})
