"""Bounded browser lifecycle for LinkedIn, with optional Browser Use V4 hosting.

Cloud browser profiles hold their own login state. No cookie export or import is
implemented. A local loopback CDP browser can be used instead on the Linux laptop.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, build_opener

from .client import _NoRedirectHandler

DEFAULT_API = "https://api.browser-use.com/api/v4"
# Backward-compatible injection point for local lifecycle tests and embedders.
API = DEFAULT_API
SAFE_USAGE = ("id", "status", "startedAt", "finishedAt", "timeoutAt", "browserCost", "proxyCost", "proxyUsedMb")
BLOCKING_FAILURE_CATEGORIES = {"cdp_error", "timeout", "connection_closed", "transport_error"}
BLOCKING_METHODS = {"Fetch.failRequest", "Fetch.continueRequest"}
BROWSER_METHODS = {"Target.getTargets", "Target.createTarget", "Target.attachToTarget",
                   "Target.closeTarget", "Page.enable", "Page.navigate", "Network.enable",
                   "Network.setExtraHTTPHeaders", "Emulation.setLocaleOverride", "Fetch.enable",
                   "Fetch.failRequest", "Fetch.continueRequest", "Runtime.evaluate"}
BROWSER_FAILURE_CATEGORIES = {"timeout", "connection_closed", "command_failed"}


class BrowserError(RuntimeError):
    pass


class CloudLifecycleUncertain(BrowserError):
    """An allocation or stop must be inspected before another paid session."""

    def __init__(self, message: str, browser_id: str | None = None):
        self.browser_id = browser_id if isinstance(browser_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", browser_id) else None
        super().__init__(message + (f" Browser ID: {self.browser_id}." if self.browser_id else ""))


class CloudBrowser:
    def __init__(
        self,
        key: str,
        profile_id: str | None,
        *,
        minutes: int = 25,
        country: str | None = None,
        api_url: str | None = None,
        profile_name: str = "Job Seeker LinkedIn",
        profile_user_id: str = "job-seeker",
    ):
        if not key or key.startswith("op://"):
            raise BrowserError("Browser Use credential is unavailable; resolve its reference at launch")
        self.key, self.profile_id = key, profile_id
        self.minutes = max(1, min(minutes, 60))
        self.country = country
        resolved_api_url = api_url or API
        parsed_api = urlparse(resolved_api_url)
        api_host = (parsed_api.hostname or "").lower()
        if (
            parsed_api.scheme not in {"http", "https"}
            or not parsed_api.netloc
            or parsed_api.query
            or parsed_api.fragment
            or (parsed_api.scheme != "https" and api_host not in {"localhost", "127.0.0.1", "::1"})
        ):
            raise BrowserError("Browser provider API URL must use HTTPS except on loopback")
        self.api_url = resolved_api_url.rstrip("/")
        self.profile_name = profile_name.strip() or "Job Seeker LinkedIn"
        self.profile_user_id = profile_user_id.strip() or "job-seeker"
        self.browser_id = None
        self.opener = build_opener(_NoRedirectHandler())
        self.usage = {}

    def request(self, method: str, path: str, body=None):
        allocating = method == "POST" and path in {"/browsers", "/profiles"}
        request = Request(self.api_url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                          headers={"X-Browser-Use-API-Key": self.key, "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=35) as response:
                raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                if allocating:
                    raise CloudLifecycleUncertain("Cloud browser allocation response exceeded its size limit; inspect the provider before retrying")
                raise BrowserError("Browser Use response exceeded its size limit")
            return json.loads(raw)
        except HTTPError as error:
            error.close()
            if allocating and error.code >= 500:
                raise CloudLifecycleUncertain("Cloud browser allocation is uncertain; inspect the provider before retrying") from None
            raise BrowserError(f"Browser Use returned HTTP {error.code}") from None
        except (OSError, ValueError):
            if allocating:
                raise CloudLifecycleUncertain("Cloud browser allocation is uncertain; inspect the provider before retrying") from None
            raise BrowserError("Browser Use request failed; an uncertain allocation must be inspected before retry") from None

    def create_profile(self):
        value = self.request(
            "POST",
            "/profiles",
            {"name": self.profile_name, "userId": self.profile_user_id},
        )
        self.profile_id = value["id"]
        return self.profile_id

    def start(self):
        if not self.profile_id:
            raise BrowserError("COMPASS_LINKEDIN_PROFILE_ID is required; run the interactive login setup first")
        value = self.request("POST", "/browsers", {
            "profileId": self.profile_id, "timeout": self.minutes,
            "proxyCountryCode": self.country, "enableRecording": False, "solveCaptchas": False,
            "metadata": {"purpose": "compass-linkedin"},
        })
        if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value["id"]):
            raise CloudLifecycleUncertain("Cloud browser allocation returned no usable ID; inspect the provider before retrying")
        self.browser_id = value["id"]
        self.usage = {key: value.get(key) for key in SAFE_USAGE}
        return value

    def stop(self):
        if not self.browser_id:
            return self.usage
        try:
            self.request("PATCH", "/browsers/" + self.browser_id, {"action": "stop"})
            value = self.request("GET", "/browsers/" + self.browser_id)
            self.usage = {key: value.get(key) for key in SAFE_USAGE}
            if value.get("status") != "stopped":
                raise BrowserError("Browser stop pending")
        except (BrowserError, AttributeError, TypeError):
            raise CloudLifecycleUncertain("Cloud browser stop was not confirmed; inspect it before another run", self.browser_id) from None
        self.browser_id = None
        return self.usage


class LinkedInBrowser:
    def __init__(
        self,
        *,
        endpoint: str | None = None,
        cloud: CloudBrowser | None = None,
        control=None,
        block_media: bool = False,
    ):
        self.endpoint, self.cloud, self.control = endpoint, cloud, control
        self.block_media = block_media is True
        self.process = None
        self.live_url = None
        self.usage = {}
        self.browser_failure = None
        self.resource_blocking = {
            "enabled": self.block_media,
            "total": 0,
            "byType": {"Image": 0, "Media": 0, "Font": 0},
            "staleRequests": 0,
            "recoveredTimeouts": 0,
        }

    @staticmethod
    def _blocking_failure(value):
        if not isinstance(value, dict) or set(value) != {"category", "cdpCode", "method"}:
            return None
        category, code, method = value["category"], value["cdpCode"], value["method"]
        if not isinstance(category, str) or category not in BLOCKING_FAILURE_CATEGORIES:
            return None
        if code is not None and (type(code) is not int or not -(2 ** 31) <= code < 2 ** 31):
            return None
        if not isinstance(method, str) or method not in BLOCKING_METHODS:
            return None
        if (category == "cdp_error") != (code is not None):
            return None
        return {"category": category, "cdpCode": code, "method": method}

    @staticmethod
    def _browser_failure(value):
        if not isinstance(value, dict) or set(value) != {"method", "category"}:
            return None
        method, category = value["method"], value["category"]
        if not isinstance(method, str) or method not in BROWSER_METHODS:
            return None
        if not isinstance(category, str) or category not in BROWSER_FAILURE_CATEGORIES:
            return None
        return {"method": method, "category": category}

    def __enter__(self):
        try:
            if self.cloud:
                session = self.cloud.start()
                self.endpoint = session["cdpUrl"]
                self.live_url = session.get("liveUrl")
            else:
                url = urlparse(self.endpoint or "")
                if url.hostname not in {"127.0.0.1", "localhost", "::1"} or url.scheme not in {"http", "ws"}:
                    raise BrowserError("Local browser endpoint must be loopback HTTP or WebSocket")
            environment = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR") if key in os.environ}
            self.process = subprocess.Popen([os.environ.get("COMPASS_NODE_BIN", "node"),
                str(Path(__file__).with_name("linkedin_browser.mjs"))], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, env=environment)
            self.command(
                "connect",
                endpoint=self.endpoint,
                dedicatedProfile=bool(self.cloud),
                blockMedia=self.block_media,
            )
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def command(self, op, **arguments):
        if self.control and self.control.cancelled:
            raise BrowserError("Compass lease lost")
        if not self.process or self.process.poll() is not None:
            raise BrowserError("LinkedIn browser process is unavailable")
        try:
            self.process.stdin.write(json.dumps({"op": op, **arguments}) + "\n")
            self.process.stdin.flush()
            # The Node transport reserves up to 100 seconds to settle required
            # blocking tasks before it emits either success or failure.
            deadline = time.monotonic() + 105
            while time.monotonic() < deadline:
                if self.control and self.control.cancelled:
                    raise BrowserError("Compass lease lost")
                if select.select([self.process.stdout], [], [], 0.25)[0]:
                    line = self.process.stdout.readline(500_001)
                    if not line or len(line) > 500_000:
                        raise BrowserError("LinkedIn browser response was missing or too large")
                    value = json.loads(line)
                    if not value.get("ok"):
                        diagnostic = self._browser_failure(value.get("browserDiagnostic"))
                        if diagnostic:
                            self.browser_failure = diagnostic
                        failure = self._blocking_failure(value.get("diagnostic"))
                        if self.block_media and failure:
                            self.resource_blocking = {**self.resource_blocking, "failure": failure}
                        raise BrowserError("LinkedIn browser: " + value.get("error", "failed"))
                    result = value.get("result", {})
                    blocking = result.pop("_resourceBlocking", None)
                    if self.block_media and isinstance(blocking, dict):
                        by_type = blocking.get("byType")
                        counts = (
                            [by_type.get(name) for name in ("Image", "Media", "Font")]
                            if isinstance(by_type, dict)
                            else []
                        )
                        recovered_timeouts = blocking.get("recoveredTimeouts", 0)
                        if (
                            type(blocking.get("total")) is int
                            and type(blocking.get("staleRequests")) is int
                            and blocking["staleRequests"] >= 0
                            and type(recovered_timeouts) is int
                            and recovered_timeouts >= 0
                            and all(type(count) is int and count >= 0 for count in counts)
                            and blocking["total"] == sum(counts)
                        ):
                            self.resource_blocking = {
                                "enabled": True,
                                "total": blocking["total"],
                                "byType": {name: by_type[name] for name in ("Image", "Media", "Font")},
                                "staleRequests": blocking["staleRequests"],
                                "recoveredTimeouts": recovered_timeouts,
                            }
                    return result
            raise BrowserError("LinkedIn browser operation timed out")
        except (OSError, ValueError):
            raise BrowserError("LinkedIn browser transport failed") from None

    def __exit__(self, *_args):
        if self.process:
            try:
                if self.process.poll() is None:
                    self.process.stdin.close()
                    self.process.wait(timeout=4)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=5)
            finally:
                self.process.stdout.close()
                self.process = None
        if self.cloud:
            self.usage = self.cloud.stop()
        if self.block_media:
            self.usage = {**self.usage, "resourceBlocking": self.resource_blocking}
        if self.browser_failure:
            self.usage = {**self.usage, "browserFailure": self.browser_failure}


def configured_browser(control=None, *, minutes=25, block_media=False):
    endpoint = os.environ.get("COMPASS_LINKEDIN_CDP_URL")
    if endpoint:
        return LinkedInBrowser(endpoint=endpoint, control=control, block_media=block_media)
    country = os.environ.get("COMPASS_LINKEDIN_PROXY_COUNTRY", "direct")
    # Browser Use's explicit null selects direct connectivity. Omitting this
    # option would silently select the provider's default residential proxy.
    cloud = CloudBrowser(
        os.environ.get("BROWSER_USE_API_KEY", ""),
        os.environ.get("COMPASS_LINKEDIN_PROFILE_ID"),
        minutes=minutes,
        country=None if country == "direct" else country,
        api_url=os.environ.get("COMPASS_BROWSER_USE_API_URL", DEFAULT_API),
        profile_name=os.environ.get("COMPASS_LINKEDIN_PROFILE_NAME", "Job Seeker LinkedIn"),
        profile_user_id=os.environ.get("COMPASS_LINKEDIN_PROFILE_USER_ID", "job-seeker"),
    )
    return LinkedInBrowser(cloud=cloud, control=control, block_media=block_media)


def main():
    parser = argparse.ArgumentParser(description="Open a bounded interactive LinkedIn cloud login")
    parser.add_argument("--login", action="store_true", required=True)
    parser.add_argument("--create-profile", action="store_true")
    args = parser.parse_args()
    browser = configured_browser(minutes=30)
    if args.create_profile:
        if not browser.cloud or browser.cloud.profile_id:
            raise BrowserError("Create-profile requires cloud mode with no existing profile configured")
        print(json.dumps({"profileId": browser.cloud.create_profile()}), flush=True)
    with browser:
        browser.command("login")
        print(json.dumps({"loginUrl": browser.live_url, "expiresInMinutes": 30,
                          "instructions": "Sign in yourself. Send probe to check or finish to save and stop."}), flush=True)
        deadline = time.monotonic() + 29 * 60
        while time.monotonic() < deadline:
            if not select.select([sys.stdin], [], [], 1)[0]:
                continue
            line = sys.stdin.readline()
            if not line or line.strip() == "finish":
                break
            if line.strip() == "probe":
                print(json.dumps(browser.command("probe")), flush=True)
    print(json.dumps({"stopped": browser.usage}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except BrowserError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
