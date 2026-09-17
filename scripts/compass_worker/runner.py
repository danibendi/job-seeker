"""Lease-aware task runner shared by the Codex and Hermes adapters."""

from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from .client import ApiError, CompassClient, TaskClaim, encode_json_body

LOGGER = logging.getLogger("compass_worker")
_MAX_COMPLETION_BODY_BYTES = 200_000
_MAX_COMPLETION_SUMMARY_UTF16_UNITS = 100_000
_LEASE_SAFETY_SECONDS = 5.0
_MAX_CONFIRMED_LEASE_SECONDS = 120.0


@dataclass
class AdapterResult:
    status: str
    summary: str
    result: dict[str, Any] = field(default_factory=dict)
    checkpoint: dict[str, Any] | None = None
    retryable: bool = False
    # Trusted adapter attestation, never inferred from model text or summaries.
    cleanup_confirmed: bool = False

    def __post_init__(self) -> None:
        if self.status not in {"succeeded", "waiting_for_user", "failed"}:
            raise ValueError(f"Unsupported adapter result status: {self.status}")
        if not self.summary.strip():
            raise ValueError("Adapter result summary cannot be empty")


class TaskControl(Protocol):
    @property
    def lease_deadline(self) -> float: ...

    @property
    def cancelled(self) -> bool: ...

    @property
    def reason(self) -> str | None: ...

    def report_progress(
        self,
        *,
        checkpoint: dict[str, Any] | None = None,
        external_ref: str | None = None,
        message: str | None = None,
    ) -> bool: ...


class TaskAdapter(Protocol):
    def run(self, claim: TaskClaim, control: TaskControl) -> AdapterResult: ...


class LeaseKeeper:
    def __init__(
        self,
        client: CompassClient,
        claim: TaskClaim,
        *,
        worker_stop: threading.Event | None = None,
    ):
        self.client = client
        self.claim = claim
        self._stop = threading.Event()
        self._cancelled = threading.Event()
        self._worker_stop = worker_stop
        self._reason: str | None = None
        self._thread: threading.Thread | None = None
        self._state_lock = threading.Lock()
        # Anchor UTC once. Later local wall-clock changes must not lengthen a
        # confirmed lease; all enforcement and renewal waits use monotonic time.
        self._wall_origin = time.time()
        self._monotonic_origin = time.monotonic()
        deadline = self._parse_deadline(claim.lease_expires_at)
        self._deadline = deadline if deadline is not None else self._monotonic_origin
        if deadline is None:
            self._cancel("lease lost: missing or invalid lease expiration")

    def _parse_deadline(self, value: Any) -> float | None:
        if not isinstance(value, str) or not value or len(value) > 128:
            return None
        try:
            expiry = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if expiry.tzinfo is None or expiry.utcoffset() is None:
                return None
            timestamp = expiry.timestamp()
        except (ValueError, OverflowError, OSError):
            return None
        if not math.isfinite(timestamp):
            return None
        return min(
            self._monotonic_origin + timestamp - self._wall_origin,
            time.monotonic() + _MAX_CONFIRMED_LEASE_SECONDS,
        ) - _LEASE_SAFETY_SECONDS

    @property
    def lease_deadline(self) -> float:
        with self._state_lock:
            return self._deadline

    @property
    def authority_valid(self) -> bool:
        # This check never waits for HTTP. Even if the renewal thread is stuck
        # reading a response, adapters observe expiry locally and can stop.
        with self._state_lock:
            if not self._cancelled.is_set() and time.monotonic() >= self._deadline:
                self._reason = "lease lost: confirmed lease deadline expired"
                self._cancelled.set()
            return not self._cancelled.is_set()

    @property
    def cancelled(self) -> bool:
        return not self.authority_valid or bool(self._worker_stop and self._worker_stop.is_set())

    @property
    def reason(self) -> str | None:
        self.cancelled  # Materialize an elapsed deadline even without a prior poll.
        if self._reason:
            return self._reason
        if self._worker_stop and self._worker_stop.is_set():
            return "worker is shutting down"
        return None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("Lease keeper already started")
        self._thread = threading.Thread(target=self._loop, name=f"lease-{self.claim.id}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def report_progress(
        self,
        *,
        checkpoint: dict[str, Any] | None = None,
        external_ref: str | None = None,
        message: str | None = None,
    ) -> bool:
        if self.cancelled:
            return False
        try:
            self.client.progress(
                self.claim.id,
                self.claim.claim_token,
                checkpoint=checkpoint,
                external_ref=external_ref,
                message=message,
            )
            return not self.cancelled
        except ApiError as error:
            if not error.retryable:
                self._cancel(f"progress rejected: {error}")
            return False

    def _cancel(self, reason: str) -> None:
        with self._state_lock:
            if not self._cancelled.is_set():
                self._reason = reason
                self._cancelled.set()

    def _accept_renewal(self, renewed: dict[str, Any]) -> bool:
        deadline = self._parse_deadline(renewed.get("lease_expires_at"))
        if deadline is None:
            self._cancel("lease lost: renewal omitted a valid lease expiration")
            return False
        with self._state_lock:
            now = time.monotonic()
            # A response arriving after the previously confirmed deadline cannot
            # revive execution, even if it describes a later server expiration.
            if now >= self._deadline or now >= deadline:
                if not self._cancelled.is_set():
                    self._reason = "lease lost: confirmed lease deadline expired"
                    self._cancelled.set()
            if self._stop.is_set() or self._cancelled.is_set():
                return False
            self._deadline = deadline
            return True

    def _loop(self) -> None:
        interval = self.claim.heartbeat_interval_seconds
        # Local shutdown stops task execution, not the lease needed to finish
        # owned-child cleanup and its final fenced interruption write.
        while self.authority_valid:
            with self._state_lock:
                remaining = max(0.0, self._deadline - time.monotonic())
            if self._stop.wait(min(interval, remaining)) or not self.authority_valid:
                return
            try:
                renewed = self.client.renew(self.claim.id, self.claim.claim_token)
                status = renewed.get("status")
                if status == "cancelled" or renewed.get("cancel_requested") is True:
                    self._cancel("task was cancelled")
                    return
                if not self._accept_renewal(renewed):
                    return
                # Renewal itself checks running status, worker, token and lease
                # server-side. A redundant GET can block the next renewal long
                # enough to lose an otherwise healthy claim.
            except ApiError as error:
                if not error.retryable or error.status in {401, 403, 404, 409, 410, 422}:
                    self._cancel(f"lease lost: {error}")
                    return
                LOGGER.warning("Lease renewal temporarily failed for task %s", self.claim.id)


class WorkerRunner:
    def __init__(
        self,
        client: CompassClient,
        adapters: dict[str, TaskAdapter],
        *,
        poll_seconds: float = 30,
    ):
        self.client = client
        self.adapters = adapters
        self.poll_seconds = max(1.0, min(float(poll_seconds), 300.0))
        self._stop = threading.Event()
        self._stop_signal: int | None = None
        self._shutdown_outcome = "not_requested"
        self._unfinalized_shutdown = False

    def request_stop(self, signal_number: int | None = None) -> None:
        """Stop polling and ask an active adapter to cancel its owned child."""
        if type(signal_number) is int and signal_number in {2, 15}:
            self._stop_signal = signal_number
        if not self._stop.is_set():
            self._shutdown_outcome = "requested"
        self._stop.set()

    def shutdown_diagnostics(self) -> dict[str, Any]:
        """Fixed nonsecret shutdown facts for the trusted native wrapper."""
        return {"signal_number": self._stop_signal, "outcome": self._shutdown_outcome,
                "unfinalized_task": self._unfinalized_shutdown}

    @staticmethod
    def _validated_result(result: Any) -> AdapterResult:
        try:
            if (
                not isinstance(result, AdapterResult)
                or not isinstance(result.status, str)
                or result.status not in {"succeeded", "waiting_for_user", "failed"}
                or not isinstance(result.summary, str)
                or not result.summary.strip()
                or not isinstance(result.result, dict)
                or (result.checkpoint is not None and not isinstance(result.checkpoint, dict))
                or not isinstance(result.retryable, bool)
                or not isinstance(result.cleanup_confirmed, bool)
            ):
                raise ValueError("invalid result shape")
            # Validate even fields omitted by this particular terminal operation:
            # success checkpoints and failure details must not hide invalid data.
            # Strict encoding also detects cycles, nonfinite dictionary keys and
            # unsupported Python objects before any terminal HTTP request starts.
            encode_json_body({"result": result.result, "checkpoint": result.checkpoint})
        except (TypeError, ValueError, OverflowError, RecursionError):
            return AdapterResult(
                status="failed",
                summary="Worker adapter returned invalid result or checkpoint data",
                retryable=False,
            )
        return result

    @staticmethod
    def _completion_payload(claim: TaskClaim, result: AdapterResult) -> dict[str, Any]:
        summary = result.summary.strip()
        # The server's JavaScript string limit counts UTF-16 code units, not
        # Python characters or request bytes. Enforce it before the byte-size
        # fast path, and never split a non-BMP character at the boundary.
        units = 0
        for index, character in enumerate(summary):
            units += 2 if ord(character) > 0xFFFF else 1
            if units > _MAX_COMPLETION_SUMMARY_UTF16_UNITS:
                summary = summary[:index]
                break
        payload = dict(result.result)
        payload["summary"] = summary
        request = {"claim_token": claim.claim_token, "result": payload}
        request_bytes = len(encode_json_body(request))
        if request_bytes <= _MAX_COMPLETION_BODY_BYTES:
            return payload

        omission = {
            "reason": "completion_payload_limit",
            "original_request_bytes": request_bytes,
        }

        def fallback(prefix_length: int) -> dict[str, Any]:
            return {
                "summary": summary[:prefix_length],
                "worker_result_omitted": omission,
            }

        low = 1
        high = len(summary)
        while low <= high:
            middle = (low + high) // 2
            candidate = fallback(middle)
            candidate_request = {"claim_token": claim.claim_token, "result": candidate}
            if len(encode_json_body(candidate_request)) <= _MAX_COMPLETION_BODY_BYTES:
                low = middle + 1
            else:
                high = middle - 1
        bounded = fallback(max(1, high))
        LOGGER.warning(
            "Omitted oversized adapter result for task %s (%d-byte completion request)",
            claim.id,
            request_bytes,
        )
        return bounded

    def run_once(self) -> bool:
        claim = self.client.claim()
        if claim is None:
            return False
        keeper = LeaseKeeper(self.client, claim, worker_stop=self._stop)
        if keeper.cancelled:
            if not keeper.authority_valid:
                if self._stop.is_set():
                    self._shutdown_outcome, self._unfinalized_shutdown = "authority_lost", True
                LOGGER.warning("Did not start task %s because %s", claim.id, keeper.reason)
                return True
        keeper.start()
        try:
            adapter = self.adapters.get(claim.executor)
            if self._stop.is_set():
                # Claim raced with shutdown, but no adapter or child ran.
                result = AdapterResult(status="failed", summary="Worker stopped before task execution",
                                       cleanup_confirmed=True)
            elif adapter is None:
                result = AdapterResult(
                    status="failed",
                    summary=f"No local adapter is configured for executor {claim.executor!r}",
                )
            else:
                try:
                    result = adapter.run(claim, keeper)
                except Exception as error:
                    LOGGER.error("Adapter failed for task %s (%s)", claim.id, type(error).__name__)
                    result = AdapterResult(
                        status="failed",
                        summary=f"Worker adapter failed ({type(error).__name__})",
                        retryable=True,
                    )

            result = self._validated_result(result)
            if self._stop.is_set():
                self._unfinalized_shutdown = True
                if not keeper.authority_valid:
                    self._shutdown_outcome = "authority_lost"
                    return True
                if not result.cleanup_confirmed:
                    self._shutdown_outcome = "cleanup_unconfirmed"
                    return True
                # Recheck immediately before the request. The app's normal
                # worker/token/attempt/lease checks remain the final fence.
                previous_checkpoint = claim.task.get("checkpoint")
                checkpoint = {**(previous_checkpoint if isinstance(previous_checkpoint, dict) else {}),
                              **(result.checkpoint or {}), "worker_shutdown": {
                    "signal_number": self._stop_signal, "cleanup_confirmed": True}}
                if not keeper.authority_valid:
                    self._shutdown_outcome = "authority_lost"
                    return True
                self._shutdown_outcome = "finalization_failed"
                self.client.fail(claim.id, claim.claim_token,
                                 error="Worker interrupted by local shutdown after confirmed child cleanup",
                                 retryable=True, waiting_for_user=False, checkpoint=checkpoint)
                self._shutdown_outcome = "interruption_finalized"
                self._unfinalized_shutdown = False
                return True
            if keeper.cancelled:
                if self._stop.is_set():
                    self._shutdown_outcome = "authority_lost" if not keeper.authority_valid else "cleanup_unconfirmed"
                    self._unfinalized_shutdown = True
                LOGGER.warning("Did not finalize task %s because %s", claim.id, keeper.reason)
                return True
            if result.status == "succeeded":
                payload = self._completion_payload(claim, result)
                if keeper.cancelled:
                    if self._stop.is_set():
                        self._shutdown_outcome, self._unfinalized_shutdown = "cleanup_unconfirmed", True
                    LOGGER.warning("Did not finalize task %s because %s", claim.id, keeper.reason)
                    return True
                self.client.complete(claim.id, claim.claim_token, payload)
            else:
                self.client.fail(
                    claim.id,
                    claim.claim_token,
                    error=result.summary,
                    retryable=result.retryable,
                    waiting_for_user=result.status == "waiting_for_user",
                    checkpoint=result.checkpoint,
                )
            if self._stop.is_set():
                self._shutdown_outcome = "task_finalized"
            return True
        finally:
            # Result encoding and the terminal HTTP write still require the
            # claim. Keep renewing until that request returns or raises; an
            # ambiguous terminal failure is not automatically replayed here.
            keeper.stop()

    def run(self, *, once: bool = False, max_polls: int | None = None,
            drain: bool = False, max_runtime_seconds: float | None = None) -> int:
        """Drain runnable work without waiting on an empty queue or retry backoff.

        The server controls retry eligibility. A native invocation exits at the
        first empty claim; it never spins until a failed task becomes due again.
        The optional deadline limits new claims, while an owned task keeps its
        normal lease and cleanup lifetime.
        """
        started = time.monotonic()
        polls = 0
        while not self._stop.is_set():
            if max_runtime_seconds is not None and time.monotonic() - started >= max_runtime_seconds:
                return 0
            try:
                claimed = self.run_once()
            except ApiError as error:
                LOGGER.error("Worker API error: %s", error)
                if self._stop.is_set():
                    self._shutdown_outcome, self._unfinalized_shutdown = "finalization_failed", True
                    return 1
                if once or drain or not error.retryable:
                    return 1
                claimed = False
            polls += 1
            if self._stop.is_set():
                if self._shutdown_outcome == "requested":
                    self._shutdown_outcome = "no_active_task"
                return 1 if self._unfinalized_shutdown else 0
            if once or (drain and not claimed) or (max_polls is not None and polls >= max_polls):
                return 0
            if not claimed:
                self._stop.wait(self.poll_seconds)
        if self._stop.is_set() and self._shutdown_outcome == "requested":
            self._shutdown_outcome = "no_active_task"
        return 1 if self._unfinalized_shutdown else 0
