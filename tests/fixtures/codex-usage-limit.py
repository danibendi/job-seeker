#!/usr/bin/env python3
"""Stand-in for the Codex CLI that reports a ChatGPT subscription usage limit.

Point COMPASS_CODEX_BIN at this file to exercise the worker's hold-and-pause
path without spending subscription quota. The events mirror what
`codex exec --json` prints when the account is out of quota: an `error` event
and a `turn.failed` event carrying the limit message, then exit status 1.
"""

import json
import sys

if "--version" in sys.argv:
    print("codex-cli 0.0.0-usage-limit-simulation")
    raise SystemExit(0)

sys.stdin.read()
message = (
    "You've hit your usage limit. Visit https://chatgpt.com/settings/usage "
    "to purchase more credits or try again later."
)
for event in (
    {"type": "thread.started", "thread_id": "simulated"},
    {"type": "turn.started"},
    {"type": "error", "message": message},
    {"type": "turn.failed", "error": {"message": message}},
):
    print(json.dumps(event), flush=True)
raise SystemExit(1)
