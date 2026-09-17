from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from urllib.parse import parse_qs, urlsplit
import unittest
from unittest.mock import MagicMock, patch

from scripts.compass_worker import browser as browser_module
from scripts.compass_worker import linkedin as linkedin_module
from scripts.compass_worker.browser import LinkedInBrowser
from scripts.compass_worker.client import TaskClaim
from scripts.compass_worker.linkedin import LinkedInCollector, SearchRoutingAdapter, page_url
from scripts.compass_worker.runner import AdapterResult


EXPECTED_NAME = "Alex Example"
AUTHENTICATED = {
    "authenticated": True,
    "challenge": False,
    "identities": [EXPECTED_NAME],
}


def claim(
    *,
    max_pages: int = 10,
    max_details: int = 30,
    max_seconds: int = 300,
    attempt: int = 2,
    sources: list[str] | None = None,
) -> TaskClaim:
    return TaskClaim(
        task={
            "id": "synthetic-linkedin-task",
            "kind": "search",
            "executor": "hermes",
            "attemptCount": attempt,
            "payload": {
                "candidateId": "candidate-1",
                "sources": ["linkedin"] if sources is None else sources,
                "budgets": {
                    "maxPages": max_pages,
                    "maxDetailFetches": max_details,
                    "maxDurationSeconds": max_seconds,
                },
            },
            "checkpoint": {},
        },
        claim_token="synthetic-claim-token",
        lease_expires_at=None,
        heartbeat_interval_seconds=30,
    )


class LinkedInDiscoveryPlanTest(unittest.TestCase):
    def policy(self):
        return {
            "schema": "compass.effective-search-policy", "schemaVersion": 1,
            "roles": {"targets": ["Technical Program Manager"]},
            "office": {"workModes": ["onsite", "hybrid"], "locations": [
                {"city": "Brno", "countryCode": "CZ", "radiusKm": 50}]},
            "remote": {"enabled": True, "includeWorldwide": True,
                       "eligibleCountryCodes": ["CZ"], "searchLocations": [
                           {"city": "Brno", "countryCode": "CZ"}]},
        }

    def test_remote_discovery_uses_saved_city_even_when_worldwide_jobs_are_eligible(self):
        plan = linkedin_module.lane_plan(self.policy(), "p" * 64)
        self.assertEqual(plan["collector_revision"], 2)
        queries = [parse_qs(urlsplit(lane["search_url"]).query) for lane in plan["lanes"]]
        self.assertEqual(len(queries), 2)
        self.assertTrue(all(query["location"] == ["Brno, CZ"] for query in queries))
        self.assertEqual(queries[0]["f_WT"], ["1,3"])
        self.assertEqual(queries[0]["distance"], ["31"])
        self.assertEqual(queries[1]["f_WT"], ["2"])
        self.assertNotIn("distance", queries[1])
        self.assertTrue(all("f_TPR" not in query for query in queries))

    def test_remote_search_locations_are_independent_of_office_and_eligibility(self):
        policy = self.policy()
        policy["remote"]["searchLocations"] = [{"city": "Berlin", "countryCode": "DE"}]
        query = parse_qs(urlsplit(linkedin_module.lane_plan(policy, "p" * 64)["lanes"][1]["search_url"]).query)
        self.assertEqual(query["location"], ["Berlin, DE"])

    def test_legacy_office_anchor_fallback_never_expands_to_worldwide(self):
        policy = self.policy()
        del policy["remote"]["searchLocations"]
        plan = linkedin_module.lane_plan(policy, "p" * 64)
        self.assertTrue(all("Worldwide" not in lane["search_url"] for lane in plan["lanes"]))
        policy["office"]["locations"] = []
        with self.assertRaisesRegex(ValueError, "remote search location"):
            linkedin_module.lane_plan(policy, "p" * 64)


class Control:
    cancelled = False

    def __init__(self) -> None:
        self.progress: list[dict] = []

    def report_progress(self, **value) -> bool:
        self.progress.append(value)
        return True


class SyntheticScanBackend:
    """Stateful injected MCP fixture; no network, account, or cookie data."""

    def __init__(self) -> None:
        self.state = None  # Fresh alias retained for boundary assertions.
        self.states = {}
        self.calls = []
        self.ingested_batches = []
        self.full_snapshots = set()
        self.completed_details = set()
        self.unavailable_details = set()
        self.unavailable_detail_tracks = {}
        self.older_pending = []
        self.pending_window = None
        self.roles = ["Technical Program Manager"]
        self.backfill_exhausted = True

    def factory(self, _app_url, _claim):
        backend = self
        class Mcp:
            def call(self, name, **arguments):
                return backend.call(name, **arguments)
        return Mcp()

    def _refresh(self, track):
        state = self.states[track]
        pending = state["pending_detail_job_ids"]
        backlog = [*self.older_pending, *(job_id for other, row in self.states.items()
                   if other != track for job_id in row["pending_detail_job_ids"])]
        track_unavailable = {
            job_id for job_id in self.unavailable_details
            if self.unavailable_detail_tracks.get(job_id) == track
        }
        state.update({"pending_detail_count": len(pending),
                      "unavailable_detail_count": len(track_unavailable),
                      "backlog_pending_detail_job_ids": list(dict.fromkeys(backlog)),
                      "backlog_pending_detail_count": len(set(backlog)),
                      "collection_complete": all(lane["exhausted"] for lane in state["lanes"]),
                      "details_complete": not pending and not track_unavailable})
        state["complete"] = state["collection_complete"] and state["details_complete"]
        state["settled"] = (
            all(lane["exhausted"] or lane.get("stop_reason") == "source_cap"
                for lane in state["lanes"])
            and not pending
            and not (self.older_pending if track == "fresh" else [])
            and not track_unavailable
            and state.get("stop_reason") not in {
                "authentication_required", "browser_unavailable",
                "pagination_unverified", "detail_unavailable",
            }
        )
        if self.pending_window:
            return {
                **state,
                "pending_detail_job_ids": pending[:self.pending_window],
                "pending_detail_ids_truncated": len(pending) > self.pending_window,
                "backlog_pending_detail_job_ids": state["backlog_pending_detail_job_ids"][:self.pending_window],
                "backlog_pending_ids_truncated": state["backlog_pending_detail_count"] > self.pending_window,
            }
        return state

    def call(self, name, **arguments):
        self.calls.append((name, arguments))
        track = arguments.get("track", "backfill")
        if name == "get_task_context":
            return {"policyHash": "p" * 64, "effectivePolicy": {
                    "schema": "compass.effective-search-policy", "schemaVersion": 1,
                    "roles": {"targets": self.roles},
                    "office": {"workModes": ["hybrid"], "locations": [
                        {"city": "Brno", "countryCode": "CZ", "radiusKm": 25}]},
                    "remote": {"enabled": False}}}
        if name == "get_linkedin_scan_state":
            if track not in self.states:
                self.states[track] = {"track": track, "plan_hash": "s" * 64,
                    "scan_started_at": "2026-09-13T08:00:00.000Z",
                    "lookback_seconds_at_start": (
                        linkedin_module.LINKEDIN_DAILY_LOOKBACK_SECONDS if track == "fresh"
                        else linkedin_module.LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS),
                    "lookback_seconds": (
                        linkedin_module.LINKEDIN_DAILY_LOOKBACK_SECONDS if track == "fresh"
                        else linkedin_module.LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS),
                    "lanes": [{**lane, "next_page": 1, "next_cursor": None,
                               "last_page_job_ids": [], "exhausted": track == "backfill" and self.backfill_exhausted,
                               "lookback_seconds_at_start": (
                                   linkedin_module.LINKEDIN_DAILY_LOOKBACK_SECONDS if track == "fresh"
                                   else linkedin_module.LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS)}
                              for lane in arguments["lanes"]], "pending_detail_job_ids": []}
            if track == "fresh": self.state = self.states[track]
            return self._refresh(track)
        if name == "lookup_linkedin_jobs":
            return {"jobs": [{"jobId": job_id, "known": job_id in self.full_snapshots,
                              "shouldFetch": job_id not in self.full_snapshots} for job_id in arguments["job_ids"]]}
        if name == "ingest_linkedin_batch":
            items = arguments["batch"]["items"]
            self.ingested_batches.append(items)
            self.full_snapshots.update(item["jobId"] for item in items if item["funnelState"] == "snapshot_ready")
            return {"accepted": len(items)}
        state = self.states[track]
        if name == "record_linkedin_scan_page":
            lane = next(lane for lane in state["lanes"] if lane["lane_key"] == arguments["lane_key"])
            lane.update({"last_page_job_ids": list(arguments["job_ids"]), "next_page": lane["next_page"] + 1,
                         "next_cursor": arguments.get("next_cursor"), "exhausted": arguments["exhausted"]})
            for job_id in arguments["pending_detail_job_ids"]:
                if job_id not in state["pending_detail_job_ids"]: state["pending_detail_job_ids"].append(job_id)
            return {"state": self._refresh(track)}
        if name == "record_linkedin_scan_details":
            for job_id in arguments["job_ids"]:
                assert job_id in self.full_snapshots
                for row in self.states.values():
                    if job_id in row["pending_detail_job_ids"]: row["pending_detail_job_ids"].remove(job_id)
                if job_id in self.older_pending: self.older_pending.remove(job_id)
                self.completed_details.add(job_id)
            return {"state": self._refresh(track)}
        if name == "record_linkedin_scan_stop":
            state["stop_reason"] = arguments["reason"]
            if arguments.get("detail_job_id"):
                job_id = arguments["detail_job_id"]
                assert job_id in state["pending_detail_job_ids"] or job_id in self.older_pending
                for row in self.states.values():
                    if job_id in row["pending_detail_job_ids"]:
                        row["pending_detail_job_ids"].remove(job_id)
                if job_id in self.older_pending:
                    self.older_pending.remove(job_id)
                self.unavailable_details.add(job_id)
                self.unavailable_detail_tracks[job_id] = track
            for job_id in arguments.get("pending_detail_job_ids", []):
                assert any(item["jobId"] == job_id for batch in self.ingested_batches for item in batch)
                if job_id not in state["pending_detail_job_ids"]:
                    state["pending_detail_job_ids"].append(job_id)
            if arguments.get("lane_key"):
                next(lane for lane in state["lanes"] if lane["lane_key"] == arguments["lane_key"])["stop_reason"] = arguments["reason"]
            return {"state": self._refresh(track)}
        raise AssertionError(f"Unexpected MCP call: {name}")


class ScriptedBrowser:
    def __init__(self, *, searches=(), details=None) -> None:
        self.searches = list(searches)
        self.details = dict(details or {})
        self.commands: list[tuple[str, dict]] = []
        self.factory_calls: list[dict] = []
        self.usage = {"status": "stopped", "browserCost": 0}
        self.exited = False

    def factory(self, **kwargs):
        self.factory_calls.append(kwargs)
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.exited = True

    def command(self, op: str, **arguments):
        self.commands.append((op, arguments))
        if op == "search":
            if not self.searches:
                raise AssertionError("Unexpected search")
            return self.searches.pop(0)
        if op == "details":
            return self.details[arguments["jobId"]]
        raise AssertionError(f"Unexpected browser command: {op}")


def search_page(
    job_ids: list[str], *, auth=AUTHENTICATED, exhausted=True, fully_loaded=True
) -> dict:
    return {
        "auth": auth,
        "items": [
            {
                "jobId": job_id,
                "title": f"Synthetic role {job_id}",
                "company": "Synthetic Company",
                "location": "Brno",
                "text": "Synthetic fixture evidence",
            }
            for job_id in job_ids
        ],
        "fullyLoaded": fully_loaded,
        "exhausted": exhausted,
        "stopReason": None,
    }


def detail(job_id: str, *, source_job_id: str | None = None, auth=AUTHENTICATED) -> dict:
    source_id = source_job_id or job_id
    return {
        "auth": auth,
        "sourceUrl": f"https://www.linkedin.com/jobs/view/{source_id}/",
        "title": f"Synthetic detail {job_id}",
        "company": "Synthetic Company",
        "location": "Brno",
        "workMode": "Hybrid",
        "description": "Synthetic full job description for collector verification.",
        "closed": False,
    }


class LinkedInCollectorBoundaryTest(unittest.TestCase):
    def run_collector(self, backend, browser, task_claim=None):
        collector = LinkedInCollector(
            "https://compass.example",
            browser_factory=browser.factory,
            mcp_factory=backend.factory,
        )
        with patch.dict(
            os.environ, {"COMPASS_LINKEDIN_EXPECTED_NAME": EXPECTED_NAME}, clear=False
        ):
            return collector.run(task_claim or claim(), Control())

    def test_missing_expected_account_stops_before_mcp_or_browser(self) -> None:
        backend = SyntheticScanBackend()
        browser = ScriptedBrowser()
        collector = LinkedInCollector(
            "https://compass.example",
            browser_factory=browser.factory,
            mcp_factory=backend.factory,
        )
        with patch.dict(os.environ, {"COMPASS_LINKEDIN_EXPECTED_NAME": ""}):
            result = collector.run(claim(), Control())
        self.assertEqual(result.status, "waiting_for_user")
        self.assertEqual(backend.calls, [])
        self.assertEqual(browser.commands, [])

    def test_media_blocking_is_an_explicit_collector_only_option(self) -> None:
        for configured, expected in ((None, False), ("1", True)):
            with self.subTest(configured=configured):
                backend = SyntheticScanBackend()
                browser = ScriptedBrowser(searches=[search_page([])])
                environment = {"COMPASS_LINKEDIN_EXPECTED_NAME": EXPECTED_NAME}
                if configured is not None:
                    environment["COMPASS_LINKEDIN_BLOCK_MEDIA"] = configured
                with patch.dict(os.environ, environment, clear=True):
                    result = self.run_collector(backend, browser)
                self.assertEqual(result.status, "succeeded")
                self.assertEqual(browser.factory_calls[0]["block_media"], expected)

    def test_signed_out_or_wrong_account_never_ingests(self) -> None:
        auth_cases = {
            "signed_out": {
                "authenticated": False,
                "challenge": False,
                "identities": [],
            },
            "wrong_account": {
                "authenticated": True,
                "challenge": False,
                "identities": ["Different Person"],
            },
            "expected_plus_conflicting_account": {
                "authenticated": True,
                "challenge": False,
                "identities": [EXPECTED_NAME, "Different Person"],
            },
        }
        for label, auth in auth_cases.items():
            with self.subTest(label=label):
                backend = SyntheticScanBackend()
                browser = ScriptedBrowser(searches=[search_page(["100000001"], auth=auth)])
                result = self.run_collector(backend, browser)
                self.assertEqual(result.status, "waiting_for_user")
                self.assertEqual(backend.ingested_batches, [])
                self.assertFalse(
                    any(name == "record_linkedin_scan_page" for name, _ in backend.calls)
                )
                stop = next(
                    item for item in result.checkpoint["linkedin_collection"]["stops"]
                    if item.get("operation") == "search"
                )
                self.assertEqual(stop["operation"], "search")
                self.assertEqual(stop["track"], "fresh")
                self.assertTrue(stop["laneKey"].startswith("lane-"))
                self.assertEqual(stop["authenticated"], bool(auth["authenticated"]))
                self.assertEqual(stop["challenge"], bool(auth["challenge"]))
                self.assertEqual(stop["identityCount"], len(set(auth["identities"])))
                self.assertFalse(stop["identityMatched"])
                self.assertNotIn("identities", stop)
                self.assertTrue(browser.exited)

    def test_detail_auth_failure_retains_sanitized_job_and_lane_evidence(self) -> None:
        job_id = "100000011"
        auth = {
            "authenticated": False,
            "challenge": True,
            "identities": ["Unexpected Private Identity"],
            "pathname": "/checkpoint/challenge/",
            "title": "Security verification | LinkedIn",
        }
        backend = SyntheticScanBackend()
        browser = ScriptedBrowser(
            searches=[search_page([job_id])],
            details={job_id: detail(job_id, auth=auth)},
        )

        result = self.run_collector(backend, browser)

        self.assertEqual(result.status, "waiting_for_user")
        checkpoint_stops = result.checkpoint["linkedin_collection"]["stops"]
        stop = next(item for item in checkpoint_stops if item.get("operation") == "detail")
        self.assertEqual(stop, {
            "track": "fresh",
            "reason": "authentication_required",
            "schemaVersion": 1,
            "authenticated": False,
            "challenge": True,
            "identityCount": 1,
            "identityMatched": False,
            "pathname": "/checkpoint/challenge/",
            "title": "Security verification | LinkedIn",
            "operation": "detail",
            "laneKey": backend.state["lanes"][0]["lane_key"],
            "jobId": job_id,
        })
        self.assertEqual(result.result["stops"], checkpoint_stops)
        self.assertEqual(result.checkpoint["linkedin_collection_result"], result.result)
        self.assertEqual(
            result.checkpoint["linkedin_collection_result"]["browser_usage"]["status"],
            "stopped",
        )
        self.assertEqual(backend.state["pending_detail_job_ids"], [job_id])
        self.assertFalse(any(
            arguments.get("detail_job_id") == job_id
            for name, arguments in backend.calls
            if name == "record_linkedin_scan_stop"
        ))
        self.assertNotIn("Unexpected Private Identity", json.dumps(result.checkpoint))

    def test_wrong_detail_final_url_is_left_pending_and_never_snapshot_ready(self) -> None:
        job_id = "100000002"
        backend = SyntheticScanBackend()
        browser = ScriptedBrowser(
            searches=[search_page([job_id])],
            details={job_id: detail(job_id, source_job_id="999999999")},
        )

        result = self.run_collector(backend, browser)

        self.assertEqual(result.status, "succeeded")
        self.assertIn("scan incomplete", result.summary)
        self.assertEqual(backend.full_snapshots, set())
        self.assertEqual(backend.state["pending_detail_job_ids"], [])
        self.assertEqual(backend.unavailable_details, {job_id})
        self.assertFalse(backend.state["details_complete"])
        self.assertFalse(
            any(
                item["funnelState"] == "snapshot_ready"
                for batch in backend.ingested_batches
                for item in batch
            )
        )
        self.assertIn(
            {"track": "fresh", "reason": "detail_unavailable", "jobId": job_id, "detail": "detail_identity_mismatch"},
            result.result["stops"],
        )

        resumed_browser = ScriptedBrowser()
        resumed = self.run_collector(
            backend, resumed_browser, claim(attempt=3)
        )
        self.assertFalse(resumed.result["resume_required"])
        self.assertEqual(resumed_browser.commands, [])

    def test_titleless_or_oversize_detail_evidence_never_becomes_snapshot_ready(self) -> None:
        titleless_id, oversize_id = "100000006", "100000007"
        titleless = detail(titleless_id)
        titleless["title"] = ""
        oversize = detail(oversize_id)
        oversize["description"] = "x" * 100_001
        backend = SyntheticScanBackend()
        browser = ScriptedBrowser(
            searches=[search_page([titleless_id, oversize_id])],
            details={titleless_id: titleless, oversize_id: oversize},
        )

        result = self.run_collector(backend, browser)

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(backend.full_snapshots, set())
        self.assertEqual(
            backend.state["pending_detail_job_ids"], []
        )
        self.assertEqual(backend.unavailable_details, {titleless_id, oversize_id})
        self.assertEqual(
            [stop.get("detail") for stop in result.result["stops"]],
            ["detail_evidence_unavailable", "detail_evidence_unavailable"],
        )

    def test_detail_budget_resume_drains_every_pending_id_before_more_pages(self) -> None:
        first_id, second_id = "100000003", "100000004"
        backend = SyntheticScanBackend()
        first_browser = ScriptedBrowser(
            searches=[search_page([first_id, second_id])],
            details={first_id: detail(first_id), second_id: detail(second_id)},
        )

        first = self.run_collector(
            backend, first_browser, claim(max_details=1, attempt=2)
        )

        self.assertEqual(first.status, "succeeded")
        self.assertFalse(backend.state["complete"])
        self.assertEqual(backend.completed_details, {first_id})
        self.assertEqual(backend.state["pending_detail_job_ids"], [second_id])
        stored = next(item for batch in backend.ingested_batches for item in batch
                      if item["jobId"] == first_id and item["funnelState"] == "snapshot_ready")
        self.assertEqual(stored["workMode"], "Hybrid")
        self.assertEqual(stored["snapshot"]["workModeText"], "Hybrid")

        resumed_browser = ScriptedBrowser(details={second_id: detail(second_id)})
        resumed = self.run_collector(
            backend, resumed_browser, claim(max_details=2, attempt=3)
        )

        self.assertEqual(resumed.status, "succeeded")
        self.assertTrue(backend.state["complete"])
        self.assertEqual(backend.completed_details, {first_id, second_id})
        self.assertEqual(
            resumed_browser.commands, [("details", {"jobId": second_id})]
        )

    def test_partial_or_repeated_page_never_marks_lane_exhausted(self) -> None:
        job_id = "100000005"
        for label in ("partial", "repeated"):
            with self.subTest(label=label):
                backend = SyntheticScanBackend()
                browser_page = search_page(
                    [job_id], exhausted=True, fully_loaded=label != "partial"
                )
                browser = ScriptedBrowser(searches=[browser_page], details={job_id: detail(job_id)})
                if label == "repeated":
                    backend.call(
                        "get_linkedin_scan_state", track="fresh",
                        **linkedin_module.lane_plan(
                            backend.call("get_task_context")["effectivePolicy"], "p" * 64
                        ),
                    )
                    backend.state["lanes"][0].update(
                        {"next_page": 2, "last_page_job_ids": [job_id]}
                    )

                result = self.run_collector(backend, browser)

                self.assertEqual(result.status, "succeeded")
                self.assertFalse(backend.state["lanes"][0]["exhausted"])
                self.assertFalse(backend.state["complete"])
                self.assertEqual(
                    backend.state["lanes"][0]["stop_reason"],
                    "pagination_unverified",
                )
                resumed_browser = ScriptedBrowser()
                resumed = self.run_collector(
                    backend, resumed_browser, claim(attempt=3)
                )
                self.assertEqual(resumed_browser.commands, [])
                self.assertFalse(resumed.result["resume_required"])
                self.assertTrue(resumed.result["provider_blocked"])

    def test_provider_capped_bootstrap_never_silently_switches_to_daily(self):
        backend = SyntheticScanBackend()
        backend.backfill_exhausted = False
        plan = linkedin_module.lane_plan(backend.call("get_task_context")["effectivePolicy"], "p" * 64)
        backend.call("get_linkedin_scan_state", track="backfill", **plan)
        backend.states["backfill"]["lanes"][0]["next_page"] = 41
        browser = ScriptedBrowser()
        result = self.run_collector(
            backend, browser, claim(max_pages=4, max_details=0)
        )
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.result["active_phase"], "bootstrap_30d")
        self.assertEqual(result.result["tracks"]["fresh"]["pages"], 0)
        self.assertEqual(result.result["tracks"]["backfill"]["pages"], 0)
        self.assertTrue(result.result["provider_blocked"])
        self.assertFalse(result.result["resume_required"])
        self.assertEqual(backend.states["backfill"]["lanes"][0]["next_page"], 41)
        self.assertFalse(backend.states["backfill"]["complete"])
        self.assertNotIn("fresh", backend.states)

        following = self.run_collector(
            backend, ScriptedBrowser(searches=[search_page([])]), claim(attempt=3)
        )
        self.assertEqual(following.result["active_phase"], "daily_1d")
        self.assertTrue(following.result["phase_settled"])

    def test_unverified_or_unavailable_bootstrap_does_not_settle(self):
        for reason in ("pagination_unverified", "detail_unavailable"):
            with self.subTest(reason=reason):
                backend = SyntheticScanBackend()
                backend.backfill_exhausted = False
                plan = linkedin_module.lane_plan(
                    backend.call("get_task_context")["effectivePolicy"], "p" * 64
                )
                state = backend.call("get_linkedin_scan_state", track="backfill", **plan)
                state["lanes"][0]["stop_reason"] = reason
                if reason == "detail_unavailable":
                    state["lanes"][0]["exhausted"] = True
                    backend.unavailable_details.add("100000089")
                    backend.unavailable_detail_tracks["100000089"] = "backfill"
                refreshed = backend.call("get_linkedin_scan_state", track="backfill", **plan)
                self.assertFalse(refreshed["settled"])

    def test_capped_lane_does_not_block_accessible_details_or_other_lanes(self):
        backend = SyntheticScanBackend()
        backend.roles = ["Capped Role", "Accessible Role"]
        old_id = "100000090"
        backend.older_pending = [old_id]
        plan = linkedin_module.lane_plan(
            backend.call("get_task_context")["effectivePolicy"], "p" * 64
        )
        state = backend.call("get_linkedin_scan_state", track="fresh", **plan)
        state["lanes"][0].update({"next_page": 41, "stop_reason": "source_cap"})
        browser = ScriptedBrowser(
            searches=[search_page([])], details={old_id: detail(old_id)}
        )

        result = self.run_collector(
            backend, browser, claim(max_pages=4, max_details=4)
        )

        self.assertEqual(
            [command[0] for command in browser.commands], ["details", "search"]
        )
        self.assertEqual(backend.completed_details, {old_id})
        self.assertTrue(backend.states["fresh"]["lanes"][1]["exhausted"])
        self.assertFalse(result.result["resume_required"])
        self.assertTrue(result.result["provider_blocked"])

    def test_capped_lane_does_not_suppress_continuation_for_resumable_lanes(self):
        backend = SyntheticScanBackend()
        backend.roles = ["Capped Role", "Started Role", "Untouched Role"]
        plan = linkedin_module.lane_plan(
            backend.call("get_task_context")["effectivePolicy"], "p" * 64
        )
        state = backend.call("get_linkedin_scan_state", track="fresh", **plan)
        state["lanes"][0].update({"next_page": 41, "stop_reason": "source_cap"})
        browser = ScriptedBrowser(
            searches=[search_page(["100000091"], exhausted=False)]
        )

        result = self.run_collector(
            backend, browser, claim(max_pages=1, max_details=0)
        )

        search_url = next(arguments["url"] for op, arguments in browser.commands if op == "search")
        self.assertEqual(parse_qs(urlsplit(search_url).query)["keywords"], ["Started Role"])
        self.assertTrue(result.result["resume_required"])
        self.assertFalse(result.result["provider_blocked"])

    def test_terminal_gap_receipt_can_continue_an_untouched_lane(self):
        backend = SyntheticScanBackend()
        backend.roles = ["Unverified Role", "Untouched Role"]
        browser = ScriptedBrowser(
            searches=[search_page(["100000092"], fully_loaded=False)]
        )

        result = self.run_collector(
            backend, browser, claim(max_pages=1, max_details=0)
        )

        self.assertEqual(result.result["collection"]["page_receipts"], 0)
        self.assertEqual(result.result["collection"]["detail_acknowledgements"], 0)
        self.assertEqual(result.result["collection"]["terminal_gap_receipts"], 1)
        self.assertTrue(result.result["resume_required"])
        self.assertFalse(result.result["provider_blocked"])

    def test_bootstrap_receives_the_whole_explicit_page_budget(self):
        backend = SyntheticScanBackend()
        backend.backfill_exhausted = False
        pages = [search_page([str(100000100 + index)], exhausted=False)
                 for index in range(32)]
        browser = ScriptedBrowser(searches=pages)

        result = self.run_collector(
            backend, browser, claim(max_pages=32, max_details=0)
        )

        receipts = [arguments for name, arguments in backend.calls
                    if name == "record_linkedin_scan_page"]
        self.assertEqual(result.result["collection"]["pages"], 32)
        self.assertEqual(result.result["tracks"]["fresh"]["pages"], 0)
        self.assertEqual(result.result["tracks"]["backfill"]["pages"], 32)
        self.assertEqual(
            [row["track"] for row in receipts], ["backfill"] * 32
        )
        self.assertEqual(
            len([command for command in browser.commands if command[0] == "search"]), 32
        )

    def test_bootstrap_stops_at_verified_exhaustion_without_spending_extra_budget(self):
        backend = SyntheticScanBackend()
        backend.backfill_exhausted = False
        pages = [search_page([str(100000200 + index)], exhausted=False)
                 for index in range(8)]
        pages.append(search_page(["100000208"], exhausted=True))
        pages.append(search_page(["100000209"], exhausted=False))
        browser = ScriptedBrowser(searches=pages)

        result = self.run_collector(
            backend, browser, claim(max_pages=10, max_details=0)
        )

        self.assertEqual(result.result["collection"]["pages"], 9)
        self.assertEqual(result.result["tracks"]["fresh"]["pages"], 0)
        self.assertEqual(result.result["tracks"]["backfill"]["pages"], 9)
        self.assertEqual(
            len([command for command in browser.commands if command[0] == "search"]), 9
        )

    def test_single_page_bootstrap_uses_the_30_day_filter(self):
        backend = SyntheticScanBackend()
        backend.backfill_exhausted = False
        browser = ScriptedBrowser(
            searches=[search_page(["100000210"], exhausted=False)]
        )

        result = self.run_collector(
            backend, browser, claim(max_pages=1, max_details=0)
        )

        self.assertEqual(result.result["collection"]["pages"], 1)
        self.assertEqual(result.result["active_phase"], "bootstrap_30d")
        self.assertEqual(result.result["tracks"]["fresh"]["pages"], 0)
        self.assertEqual(result.result["tracks"]["backfill"]["pages"], 1)
        search_url = next(
            arguments["url"]
            for op, arguments in browser.commands
            if op == "search"
        )
        lookback = int(parse_qs(urlsplit(search_url).query)["f_TPR"][0][1:])
        self.assertGreaterEqual(lookback, linkedin_module.LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS)

    def test_daily_starts_only_on_a_following_task_after_bootstrap_completion(self):
        backend = SyntheticScanBackend()
        backend.backfill_exhausted = False
        first = self.run_collector(backend, ScriptedBrowser(searches=[search_page([])]))
        self.assertEqual(first.result["active_phase"], "bootstrap_30d")
        self.assertTrue(first.result["phase_complete"])
        self.assertNotIn("fresh", backend.states)

        second_browser = ScriptedBrowser(searches=[search_page([])])
        second = self.run_collector(backend, second_browser, claim(attempt=3))
        self.assertEqual(second.result["active_phase"], "daily_1d")
        self.assertTrue(second.result["phase_complete"])
        daily_url = next(arguments["url"] for op, arguments in second_browser.commands if op == "search")
        daily_lookback = int(parse_qs(urlsplit(daily_url).query)["f_TPR"][0][1:])
        self.assertGreaterEqual(daily_lookback, linkedin_module.LINKEDIN_DAILY_LOOKBACK_SECONDS)

    def test_fresh_pages_and_details_are_spread_across_lanes(self):
        backend = SyntheticScanBackend()
        backend.roles = ["Technical Program Manager", "Implementation Project Manager"]
        ids = ["100000021", "100000022", "100000023", "100000024"]
        browser = ScriptedBrowser(searches=[search_page(ids[:2], exhausted=False), search_page(ids[2:], exhausted=False)],
                                  details={job_id: detail(job_id) for job_id in ids})
        result = self.run_collector(backend, browser, claim(max_pages=2, max_details=2))
        searches = [arguments["url"] for op, arguments in browser.commands if op == "search"]
        self.assertEqual(len(searches), 2)
        self.assertNotEqual(parse_qs(urlsplit(searches[0]).query)["keywords"], parse_qs(urlsplit(searches[1]).query)["keywords"])
        self.assertEqual(backend.full_snapshots, {ids[0], ids[2]})
        self.assertEqual(result.result["collection"]["details"], 2)

    def test_compatible_daily_backlog_is_drained_before_new_details(self):
        backend = SyntheticScanBackend()
        old_id = "100000030"
        fresh_ids = ["100000031", "100000032", "100000033", "100000034", "100000035"]
        backend.older_pending = [old_id]
        browser = ScriptedBrowser(searches=[search_page(fresh_ids)],
                                  details={job_id: detail(job_id) for job_id in [old_id, *fresh_ids]})
        self.run_collector(backend, browser, claim(max_details=5))
        reads = [arguments["jobId"] for op, arguments in browser.commands if op == "details"]
        self.assertEqual(reads, [old_id, *fresh_ids[:4]])
        self.assertIn(fresh_ids[-1], backend.state["pending_detail_job_ids"])
        self.assertEqual(backend.older_pending, [])

    def test_pending_transport_windows_do_not_create_a_300_job_ingestion_cap(self):
        backend = SyntheticScanBackend()
        backend.pending_window = 300
        backend.older_pending = [str(200000000 + index) for index in range(305)]
        backend.full_snapshots.update(backend.older_pending)
        browser = ScriptedBrowser(searches=[search_page([])])

        result = self.run_collector(backend, browser, claim(max_details=1))

        self.assertEqual(len(backend.completed_details), 305)
        self.assertEqual(result.result["collection"]["detail_acknowledgements"], 305)
        self.assertEqual([op for op, _arguments in browser.commands], ["search"])

    def test_stopped_provider_cost_is_reported_as_browser_plus_network(self):
        backend = SyntheticScanBackend()
        browser = ScriptedBrowser(searches=[search_page([])])
        browser.usage = {"status": "stopped", "browserCost": "0.0025",
                         "proxyCost": "0.0875", "proxyUsedMb": 450.0}

        result = self.run_collector(backend, browser)

        self.assertEqual(result.result["browser_cost"], {
            "browser_usd": 0.0025,
            "network_usd": 0.0875,
            "measured_total_usd": 0.09,
            "network_mb": 450.0,
        })

    def test_failed_gap_persistence_is_reported_to_the_router(self):
        backend = SyntheticScanBackend()
        original = backend.call
        def call(name, **arguments):
            if name == "record_linkedin_scan_stop":
                raise linkedin_module.ApiError("Synthetic durable-write failure")
            return original(name, **arguments)
        backend.call = call
        browser = ScriptedBrowser(searches=[search_page([], auth={"authenticated": False, "challenge": True})])
        result = self.run_collector(backend, browser)
        self.assertEqual(result.status, "waiting_for_user")
        self.assertTrue(result.cleanup_confirmed)
        self.assertFalse(result.result["gap_recorded"])

    def test_partial_page_retains_observed_ids_even_with_no_detail_budget(self):
        backend = SyntheticScanBackend()
        job_id = "100000040"
        browser = ScriptedBrowser(searches=[search_page([job_id], fully_loaded=False)])
        result = self.run_collector(backend, browser, claim(max_details=0))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(backend.state["lanes"][0]["next_page"], 1)
        self.assertEqual(backend.state["pending_detail_job_ids"], [job_id])

    def test_failed_browser_request_consumes_the_shared_page_budget(self):
        backend = SyntheticScanBackend()
        backend.backfill_exhausted = False
        browser = ScriptedBrowser()
        browser.command = MagicMock(side_effect=linkedin_module.BrowserError("Synthetic navigation timeout"))
        result = self.run_collector(backend, browser)
        self.assertEqual(result.status, "failed")
        self.assertTrue(result.cleanup_confirmed)
        self.assertTrue(result.result["gap_recorded"])
        self.assertEqual(result.result["collection"]["pages"], 1)
        self.assertEqual(result.result["active_phase"], "bootstrap_30d")
        self.assertEqual(
            result.checkpoint["linkedin_collection"]["activePhase"],
            result.result["active_phase"],
        )


class BrowserBoundaryTest(unittest.TestCase):
    def test_resource_blocking_receipt_keeps_stale_request_telemetry(self) -> None:
        process = MagicMock()
        process.poll.return_value = None
        process.stdout.readline.return_value = json.dumps({"ok": True, "result": {
            "_resourceBlocking": {"enabled": True, "total": 6,
                "byType": {"Image": 3, "Media": 2, "Font": 1}, "staleRequests": 4,
                "recoveredTimeouts": 2},
        }}) + "\n"
        browser = LinkedInBrowser(endpoint="ws://127.0.0.1:9222", block_media=True)
        browser.process = process
        with patch.object(browser_module.select, "select", return_value=([process.stdout], [], [])):
            self.assertEqual(browser.command("probe"), {})
        process.poll.return_value = 0
        browser.__exit__()
        self.assertEqual(browser.usage["resourceBlocking"], {
            "enabled": True,
            "total": 6,
            "byType": {"Image": 3, "Media": 2, "Font": 1},
            "staleRequests": 4,
            "recoveredTimeouts": 2,
        })

    def test_resource_blocking_failure_receipt_accepts_only_bounded_diagnostics(self) -> None:
        valid = {"category": "cdp_error", "cdpCode": -32000,
                 "method": "Fetch.failRequest"}
        self.assertEqual(LinkedInBrowser._blocking_failure(valid), valid)
        for unsafe in (
            {**valid, "providerMessage": "signed endpoint"},
            {**valid, "method": "Page.navigate"},
            {**valid, "category": "provider_error"},
            {**valid, "cdpCode": "-32000"},
            {**valid, "cdpCode": None},
            {**valid, "category": "timeout"},
            {**valid, "method": ["Fetch.failRequest"]},
            {**valid, "category": {"cdp_error": True}},
        ):
            with self.subTest(unsafe=unsafe):
                self.assertIsNone(LinkedInBrowser._blocking_failure(unsafe))

        process = MagicMock()
        process.poll.return_value = None
        process.stdout.readline.return_value = json.dumps({"ok": False,
            "error": "resource_blocking_failed", "diagnostic": valid}) + "\n"
        browser = LinkedInBrowser(endpoint="ws://127.0.0.1:9222", block_media=True)
        browser.process = process
        with patch.object(browser_module.select, "select", return_value=([process.stdout], [], [])):
            with self.assertRaisesRegex(browser_module.BrowserError, "resource_blocking_failed"):
                browser.command("probe")
        process.poll.return_value = 0
        browser.__exit__()
        self.assertEqual(browser.usage["resourceBlocking"]["failure"], valid)

    def test_browser_failure_receipt_accepts_only_safe_cdp_diagnostics(self) -> None:
        valid = {"method": "Runtime.evaluate", "category": "timeout"}
        sanitized = LinkedInBrowser._browser_failure(valid)
        self.assertEqual(sanitized, valid)
        self.assertIsNot(sanitized, valid)
        for unsafe in (
            {**valid, "url": "https://provider.invalid/signed?token=synthetic-secret"},
            {**valid, "message": "Provider returned a private endpoint"},
            {**valid, "method": "https://provider.invalid/private"},
            {**valid, "method": ["Runtime.evaluate"]},
            {**valid, "category": {"timeout": True}},
            {**valid, "category": "provider_error"},
        ):
            with self.subTest(unsafe=unsafe):
                self.assertIsNone(LinkedInBrowser._browser_failure(unsafe))

        process = MagicMock()
        process.poll.return_value = None
        process.stdout.readline.return_value = json.dumps({
            "ok": False,
            "error": "browser_timeout",
            "browserDiagnostic": valid,
        }) + "\n"
        browser = LinkedInBrowser(endpoint="ws://127.0.0.1:9222")
        browser.process = process
        with patch.object(browser_module.select, "select", return_value=([process.stdout], [], [])):
            with self.assertRaisesRegex(browser_module.BrowserError, "browser_timeout"):
                browser.command("probe")
        process.poll.return_value = 0
        browser.__exit__()
        self.assertEqual(browser.usage["browserFailure"], valid)

    def test_browser_subprocess_receives_no_credentials_or_signed_endpoint(self) -> None:
        process = MagicMock()
        process.poll.return_value = None
        popen = MagicMock(return_value=process)
        sensitive = {
            "BROWSER_USE_API_KEY": "synthetic-browser-key",
            "COMPASS_LINKEDIN_PROFILE_ID": "synthetic-profile",
            "COMPASS_WORKER_TOKEN": "synthetic-worker-token",
            "HERMES_API_TOKEN": "synthetic-hermes-token",
        }
        endpoint = "ws://127.0.0.1:9222/devtools/browser/synthetic-signed-part"
        with patch.dict(os.environ, sensitive, clear=False), patch.object(
            browser_module.subprocess, "Popen", popen
        ), patch.object(LinkedInBrowser, "command", return_value={"connected": True}) as command:
            with LinkedInBrowser(endpoint=endpoint):
                pass

        argv = popen.call_args.args[0]
        child_env = popen.call_args.kwargs["env"]
        self.assertNotIn(endpoint, argv)
        self.assertEqual(command.call_args.kwargs["endpoint"], endpoint)
        self.assertFalse(command.call_args.kwargs["blockMedia"])
        for name in sensitive:
            self.assertNotIn(name, child_env)

    def test_cloud_session_is_stopped_when_browser_process_launch_raises(self) -> None:
        class Cloud:
            profile_id = "synthetic-profile"

            def __init__(self):
                self.stop_calls = 0

            def start(self):
                return {
                    "cdpUrl": "wss://synthetic.invalid/signed",
                    "liveUrl": "https://synthetic.invalid/live",
                }

            def stop(self):
                self.stop_calls += 1
                return {"status": "stopped"}

        cloud = Cloud()
        with patch.object(browser_module.subprocess, "Popen", side_effect=OSError):
            with self.assertRaises(OSError):
                LinkedInBrowser(cloud=cloud).__enter__()
        self.assertEqual(cloud.stop_calls, 1)

    def test_daily_lookback_is_one_day_and_its_lower_bound_stays_anchored(self) -> None:
        real_datetime = datetime

        class Clock:
            current = real_datetime(2026, 9, 13, 8, 0, 0, tzinfo=timezone.utc)

            @classmethod
            def now(cls, _tz):
                return cls.current

            @classmethod
            def fromisoformat(cls, value):
                return real_datetime.fromisoformat(value)

        lane = {
            "search_url": "https://www.linkedin.com/jobs/search/?keywords=TPM",
            "next_page": 1,
        }
        state = {
            "scan_started_at": "2026-09-13T08:00:00Z",
            "lookback_seconds_at_start": linkedin_module.LINKEDIN_DAILY_LOOKBACK_SECONDS,
            "lookback_seconds": linkedin_module.LINKEDIN_DAILY_LOOKBACK_SECONDS,
        }
        with patch.object(linkedin_module, "datetime", Clock):
            first = page_url(lane, state)
            Clock.current = real_datetime(2026, 9, 13, 8, 2, 10, tzinfo=timezone.utc)
            second = page_url(lane, state)

        first_duration = int(parse_qs(urlsplit(first).query)["f_TPR"][0][1:])
        second_duration = int(parse_qs(urlsplit(second).query)["f_TPR"][0][1:])
        self.assertEqual(first_duration, 86_400)
        self.assertEqual(second_duration, 86_530)
        self.assertEqual(
            real_datetime(2026, 9, 13, 8, 0, 0, tzinfo=timezone.utc).timestamp()
            - first_duration,
            Clock.current.timestamp() - second_duration,
        )
        lane["lookback_seconds_at_start"] = 1000
        with patch.object(linkedin_module, "datetime", Clock):
            per_lane = page_url(lane, state)
        self.assertEqual(parse_qs(urlsplit(per_lane).query)["f_TPR"], ["r1130"])


class SearchRoutingBudgetTest(unittest.TestCase):
    class Hermes:
        def __init__(self) -> None:
            self.claims: list[TaskClaim] = []

        def run(self, staged_claim, _control):
            self.claims.append(staged_claim)
            return AdapterResult(
                status="succeeded",
                summary="Public web complete",
                cleanup_confirmed=True,
                checkpoint={"public_web": {"complete": True}},
                result={"public_web": {"jobs": 2}},
            )

    class Collector:
        def __init__(self, *, pages=3, details=4) -> None:
            self.claims: list[TaskClaim] = []
            self.pages = pages
            self.details = details

        def run(self, collection_claim, _control):
            self.claims.append(collection_claim)
            return AdapterResult(
                status="succeeded",
                summary="LinkedIn collection complete.",
                checkpoint={
                    "linkedin_collection": {
                        "attempt": collection_claim.task["attemptCount"],
                        "collected": True,
                        "planHash": "synthetic-plan",
                    }
                },
                result={
                    "collection": {
                        "pages": self.pages,
                        "details": self.details,
                        "observed": 20,
                    },
                    "browser_usage": {
                        "id": "synthetic-browser",
                        "status": "stopped",
                        "browserCost": "0.001",
                        "proxyCost": "0.002",
                    },
                    "coverage_claim": "synthetic scoped fixture",
                },
                cleanup_confirmed=True,
            )

    @staticmethod
    def clock(*values):
        readings = iter(values)
        return lambda: next(readings)

    def test_mixed_search_uses_one_shrinking_budget_and_merges_checkpoints(self) -> None:
        hermes = self.Hermes()
        collector = self.Collector(pages=3, details=4)
        adapter = SearchRoutingAdapter(
            "https://synthetic.invalid",
            hermes,
            clock=self.clock(100.0, 201.0),
        )
        adapter.collector = collector
        mixed = claim(
            max_pages=10,
            max_details=30,
            max_seconds=1200,
            sources=["linkedin", "public"],
        )
        mixed.task["checkpoint"] = {"prior": {"cursor": "synthetic"}}
        control = Control()

        result = adapter.run(mixed, control)

        self.assertEqual(
            collector.claims[0].task["payload"]["budgets"],
            {
                "maxPages": 8,
                "maxDetailFetches": 30,
                "maxDurationSeconds": 960,
            },
        )
        self.assertEqual(len(hermes.claims), 1)
        staged = hermes.claims[0].task
        self.assertEqual(
            staged["payload"]["budgets"],
            {
                "maxPages": 7,
                "maxDetailFetches": 26,
                "maxDurationSeconds": 1099,
            },
        )
        budget = staged["checkpoint"]["public_search_remaining_budget"]
        self.assertEqual(budget["linkedinUsed"]["durationSeconds"], 101)
        self.assertEqual(budget["remaining"], staged["payload"]["budgets"])
        self.assertEqual(staged["checkpoint"]["prior"]["cursor"], "synthetic")
        self.assertTrue(staged["checkpoint"]["linkedin_collection"]["collected"])
        self.assertEqual(
            staged["checkpoint"]["linkedin_collection_result"],
            result.result["linkedin_collection"],
        )
        self.assertEqual(control.progress[-1]["checkpoint"], staged["checkpoint"])
        self.assertEqual(
            result.result["linkedin_collection"],
            {
                "collection": {"pages": 3, "details": 4, "observed": 20},
                "browser_usage": {
                    "id": "synthetic-browser",
                    "status": "stopped",
                    "browserCost": "0.001",
                    "proxyCost": "0.002",
                },
                "coverage_claim": "synthetic scoped fixture",
            },
        )
        self.assertTrue(result.checkpoint["linkedin_collection"]["collected"])
        self.assertTrue(result.checkpoint["public_web"]["complete"])

    def test_mixed_search_skips_semantic_stage_when_time_is_insufficient(self) -> None:
        hermes = self.Hermes()
        collector = self.Collector(pages=2, details=3)
        adapter = SearchRoutingAdapter(
            "https://synthetic.invalid",
            hermes,
            clock=self.clock(10.0, 85.0),
        )
        adapter.collector = collector

        result = adapter.run(
            claim(max_seconds=100, sources=["linkedin", "public"]),
            Control(),
        )

        self.assertEqual(collector.claims[0].task["payload"]["budgets"]["maxDurationSeconds"], 80)
        self.assertEqual(hermes.claims, [])
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.result["public_web"]["status"], "skipped")
        self.assertEqual(
            result.checkpoint["linkedin_collection_result"]["browser_usage"]["status"],
            "stopped",
        )
        self.assertEqual(
            result.result["public_web"]["remaining_budget"]["maxDurationSeconds"],
            25,
        )

    def test_linkedin_only_keeps_full_budget_and_never_launches_hermes(self) -> None:
        hermes = self.Hermes()
        collector = self.Collector()
        adapter = SearchRoutingAdapter("https://synthetic.invalid", hermes)
        adapter.collector = collector
        linkedin_only = claim(max_seconds=1200)

        result = adapter.run(linkedin_only, Control())

        self.assertEqual(result.status, "succeeded")
        self.assertIs(collector.claims[0], linkedin_only)
        self.assertEqual(hermes.claims, [])

    def test_public_continues_after_a_durably_recorded_clean_linkedin_failure(self):
        hermes = self.Hermes()
        adapter = SearchRoutingAdapter("https://synthetic.invalid", hermes, clock=self.clock(0, 30))
        adapter.collector = MagicMock()
        adapter.collector.run.return_value = AdapterResult(status="waiting_for_user", summary="Sign-in needed",
            cleanup_confirmed=True, result={"gap_recorded": True, "collection": {"pages": 1, "details": 0}})
        result = adapter.run(claim(sources=["linkedin", "public"]), Control())
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.result["status"], "partial")
        self.assertEqual(result.result["linkedin_status"], "waiting_for_user")
        self.assertTrue(result.cleanup_confirmed)
        staged = hermes.claims[0].task
        self.assertEqual(staged["payload"]["budgets"]["maxPages"], 9)
        self.assertTrue(staged["checkpoint"]["linkedin_collection"]["stage_finished"])
        self.assertFalse(staged["checkpoint"]["linkedin_collection"]["collected"])

    def test_retryable_linkedin_failure_returns_before_public_and_keeps_receipt(self):
        receipt = {
            "id": "8fd72561-0000-4000-8000-000000000001",
            "status": "stopped",
            "browserCost": "0.000333",
            "proxyCost": "0",
        }
        checkpoint = {
            "linkedin_collection": {"attempt": 1, "collected": False},
            "linkedin_collection_result": {"browser_usage": receipt},
        }
        failure = AdapterResult(
            status="failed",
            summary="LinkedIn browser: browser_timeout",
            retryable=True,
            cleanup_confirmed=True,
            checkpoint=checkpoint,
            result={
                "gap_recorded": True,
                "collection": {"pages": 1, "details": 0, "observed": 0},
                "browser_usage": receipt,
            },
        )
        hermes = self.Hermes()
        adapter = SearchRoutingAdapter(
            "https://synthetic.invalid", hermes, clock=self.clock(0, 30)
        )
        adapter.collector = MagicMock()
        adapter.collector.run.return_value = failure
        control = Control()

        result = adapter.run(claim(sources=["linkedin", "public"]), control)

        self.assertIs(result, failure)
        self.assertTrue(result.retryable)
        self.assertTrue(result.cleanup_confirmed)
        self.assertIs(result.checkpoint, checkpoint)
        self.assertIs(
            result.checkpoint["linkedin_collection_result"]["browser_usage"], receipt
        )
        self.assertEqual(hermes.claims, [])
        self.assertEqual(control.progress, [])

    def test_public_never_starts_after_uncertain_cleanup_lost_lease_or_missing_gap(self):
        for cleanup, gap, cancelled in [(False, True, False), (True, False, False), (True, True, True)]:
            with self.subTest(cleanup=cleanup, gap=gap, cancelled=cancelled):
                hermes = self.Hermes()
                adapter = SearchRoutingAdapter("https://synthetic.invalid", hermes, clock=self.clock(0, 30))
                adapter.collector = MagicMock()
                failure = AdapterResult(status="failed", summary="Collector unavailable", cleanup_confirmed=cleanup,
                                        result={"gap_recorded": gap, "collection": {"pages": 1}})
                adapter.collector.run.return_value = failure
                control = Control(); control.cancelled = cancelled
                result = adapter.run(claim(sources=["linkedin", "public"]), control)
                self.assertIs(result, failure)
                self.assertEqual(hermes.claims, [])

    def test_clean_public_failure_finishes_an_honest_partial_collection_chunk(self):
        for status, public_status in (("waiting_for_user", "blocked"), ("failed", "failed")):
            with self.subTest(status=status):
                hermes = MagicMock()
                hermes.run.return_value = AdapterResult(
                    status=status,
                    summary="Native public queue unavailable",
                    result={"provider": "synthetic-public"},
                    checkpoint={"hermes": {"card_id": "synthetic-card"}},
                    retryable=status == "failed",
                    cleanup_confirmed=True,
                )
                collector = self.Collector(pages=8, details=0)
                adapter = SearchRoutingAdapter(
                    "https://synthetic.invalid", hermes, clock=self.clock(0, 30)
                )
                adapter.collector = collector

                result = adapter.run(claim(sources=["linkedin", "public"]), Control())

                self.assertEqual(result.status, "succeeded")
                self.assertTrue(result.cleanup_confirmed)
                self.assertEqual(result.result["status"], "partial")
                self.assertEqual(result.result["public_web"], {
                    "provider": "synthetic-public",
                    "status": public_status,
                    "summary": "Native public queue unavailable",
                    "retryable": status == "failed",
                })
                self.assertEqual(
                    result.result["linkedin_collection"]["browser_usage"]["id"],
                    "synthetic-browser",
                )
                self.assertEqual(
                    result.checkpoint["linkedin_collection_result"],
                    result.result["linkedin_collection"],
                )
                self.assertIn(f"Public-web stage {public_status}", result.summary)

    def test_public_failure_stays_terminal_without_both_clean_success_attestations(self):
        for collection_status, collection_cleanup, public_cleanup in (
            ("succeeded", False, True),
            ("succeeded", True, False),
            ("waiting_for_user", True, True),
        ):
            with self.subTest(
                collection_status=collection_status,
                collection_cleanup=collection_cleanup,
                public_cleanup=public_cleanup,
            ):
                hermes = MagicMock()
                public_failure = AdapterResult(
                    status="waiting_for_user",
                    summary="Synthetic public stop",
                    cleanup_confirmed=public_cleanup,
                )
                hermes.run.return_value = public_failure
                adapter = SearchRoutingAdapter(
                    "https://synthetic.invalid", hermes, clock=self.clock(0, 30)
                )
                adapter.collector = MagicMock()
                adapter.collector.run.return_value = AdapterResult(
                    status=collection_status,
                    summary="Synthetic collection stop",
                    cleanup_confirmed=collection_cleanup,
                    checkpoint={"linkedin_collection": {"attempt": 2, "collected": True}},
                    result={
                        "gap_recorded": True,
                        "collection": {"pages": 1, "details": 0},
                        "browser_usage": {"status": "stopped"},
                    },
                )

                result = adapter.run(claim(sources=["linkedin", "public"]), Control())

                self.assertIs(result, public_failure)
                self.assertEqual(result.status, "waiting_for_user")


if __name__ == "__main__":
    unittest.main()
