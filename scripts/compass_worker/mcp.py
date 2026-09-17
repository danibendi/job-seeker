"""Task-capability-only MCP client used by deterministic collection.

The long-lived worker credential must never be supplied to this client.
Responses may use JSON or the stateless MCP server's SSE envelope.
"""
from __future__ import annotations

import json
from urllib.error import HTTPError
from urllib.request import Request, build_opener

from .client import ApiError, TaskClaim, _NoRedirectHandler, join_app_path, normalize_app_url


class TaskMcp:
    def __init__(self, app_url: str, claim: TaskClaim, *, timeout: float = 30):
        self.url = join_app_path(normalize_app_url(app_url), "api/worker/mcp")
        self.claim = claim
        self.timeout = timeout
        self.opener = build_opener(_NoRedirectHandler())
        self.sequence = 0

    def call(self, name: str, **arguments):
        self.sequence += 1
        body = {"jsonrpc": "2.0", "id": self.sequence, "method": "tools/call", "params": {
            "name": name, "arguments": {**arguments, "task_id": self.claim.id,
                                        "attempt": self.claim.task["attemptCount"]}}}
        request = Request(self.url, data=json.dumps(body, allow_nan=False).encode(), headers={
            "Authorization": "Bearer " + self.claim.claim_token,
            "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
        })
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(1_500_001)
            if len(raw) > 1_500_000:
                raise ApiError("Task MCP response exceeded its size limit")
            decoded = raw.decode()
            if decoded.lstrip().startswith("{"):
                envelope = json.loads(decoded)
            else:
                messages = [json.loads(line[6:]) for line in decoded.splitlines() if line.startswith("data: ")]
                envelope = next(item for item in messages if item.get("id") == self.sequence)
            if envelope.get("error"):
                raise ApiError("Task MCP rejected the request")
            result = envelope["result"]
            if result.get("isError"):
                # Server tool errors can contain evidence. Keep failures out of logs.
                raise ApiError(f"Task MCP tool {name} failed")
            blocks = [item["text"] for item in result.get("content", []) if item.get("type") == "text"]
            return json.loads(blocks[0])
        except HTTPError as error:
            error.close()
            raise ApiError(f"Task MCP returned HTTP {error.code}", status=error.code,
                           retryable=error.code == 429 or error.code >= 500) from None
        except (OSError, ValueError, KeyError, IndexError, StopIteration):
            raise ApiError("Task MCP returned an invalid or unavailable response", retryable=True) from None
