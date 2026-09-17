"""Deterministic, resumable LinkedIn collection before Hermes evaluation.

Completeness means the declared, visible search lanes were exhausted. LinkedIn's
index, ranking, delayed postings and result cap prevent a global completeness
claim. Full evidence is read only for IDs the app says need it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
import math
import os
import sys
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .browser import BrowserError, CloudLifecycleUncertain, configured_browser
from .client import ApiError, TaskClaim
from .mcp import TaskMcp
from .runner import AdapterResult

LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS = 30 * 24 * 60 * 60
LINKEDIN_DAILY_LOOKBACK_SECONDS = 24 * 60 * 60
LINKEDIN_PROVIDER_PAGE_SIZE = 25
LINKEDIN_PROVIDER_MAX_PAGES_PER_LANE = 40
LINKEDIN_PROVIDER_VISIBLE_RESULT_CAP = (
    LINKEDIN_PROVIDER_PAGE_SIZE * LINKEDIN_PROVIDER_MAX_PAGES_PER_LANE
)


class AuthenticationRequired(BrowserError):
    def __init__(self, message, evidence):
        super().__init__(message)
        self.evidence = evidence


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def measured_dollars(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) and parsed >= 0 else None


def lane_plan(policy: dict, policy_hash: str):
    if policy.get("schema") != "compass.effective-search-policy" or policy.get("schemaVersion") != 1:
        raise ValueError("Compass returned an unsupported effective search policy")
    roles = policy.get("roles", {}).get("targets") or []
    if not roles:
        raise ValueError("Set explicit target roles in Compass before starting LinkedIn searches")
    places = []
    office = policy.get("office", {})
    if office.get("workModes"):
        for location in office.get("locations", []):
            places.append((f"{location['city']}, {location['countryCode']}",
                           ",".join("1" if mode == "onsite" else "3" for mode in office["workModes"]),
                           str(round(location.get("radiusKm", 0) / 1.609344))))
    remote = policy.get("remote", {})
    if remote.get("enabled"):
        # LinkedIn includes region-targeted remote vacancies in a matching city
        # search. Apply that configured geography
        # before description reads; worldwide eligibility is not a request to
        # search every country's remote vacancies.
        search_locations = remote.get("searchLocations", office.get("locations", []))
        if not search_locations:
            raise ValueError("Set a remote search location in Compass before starting LinkedIn searches")
        for location in search_locations:
            place = (f"{location['city']}, {location['countryCode']}", "2", None)
            if place not in places:
                places.append(place)
    if not places:
        raise ValueError("The search policy contains no enabled office or remote scope")
    lanes = []
    for role in roles:
        for place, mode, distance in places:
            query = role.strip()
            parameters = {"keywords": query, "location": place, "sortBy": "DD", "f_WT": mode}
            if distance:
                parameters["distance"] = distance
            url = "https://www.linkedin.com/jobs/search/?" + urlencode(parameters)
            key = "lane-" + hashlib.sha256(url.encode()).hexdigest()[:20]
            lanes.append({"lane_key": key, "query": query, "search_url": url})
    if len(lanes) > 64:
        raise ValueError("Search policy creates more than 64 lanes; narrow the explicit search scope")
    return {"schema_version": 2, "collector_revision": 2,
            "policy_hash": policy_hash, "lanes": lanes}


def page_url(lane, state):
    parsed = urlsplit(lane["search_url"])
    parameters = dict(parse_qsl(parsed.query))
    parameters["start"] = str((lane["next_page"] - 1) * LINKEDIN_PROVIDER_PAGE_SIZE)
    lookback = lane.get("lookback_seconds_at_start", state.get("lookback_seconds_at_start", state.get("lookback_seconds")))
    if lookback:
        started = datetime.fromisoformat(state["scan_started_at"].replace("Z", "+00:00"))
        elapsed = max(0, math.ceil((datetime.now(timezone.utc) - started).total_seconds()))
        parameters["f_TPR"] = "r" + str(lookback + elapsed)
    return urlunsplit(parsed._replace(query=urlencode(parameters)))


def sanitized_auth_evidence(auth, expected, *, operation=None, track=None,
                            lane_key=None, job_id=None):
    identities = {
        " ".join(value.casefold().split())
        for value in auth.get("identities", [])
        if isinstance(value, str) and value.strip()
    }
    normalized_expected = " ".join(expected.casefold().split())
    evidence = {
        "schemaVersion": 1,
        "authenticated": bool(auth.get("authenticated")),
        "challenge": bool(auth.get("challenge")),
        "identityCount": len(identities),
        "identityMatched": identities == {normalized_expected},
    }
    pathname = auth.get("pathname")
    if isinstance(pathname, str) and pathname.startswith("/") and len(pathname) <= 500:
        evidence["pathname"] = pathname
    title = auth.get("title")
    if isinstance(title, str) and title.strip() and len(title) <= 500:
        evidence["title"] = " ".join(title.split())
    if operation in {"search", "detail"}:
        evidence["operation"] = operation
    if track in {"fresh", "backfill"}:
        evidence["track"] = track
    if isinstance(lane_key, str) and lane_key.startswith("lane-") and len(lane_key) <= 160:
        evidence["laneKey"] = lane_key
    if isinstance(job_id, str) and job_id.isdigit() and 6 <= len(job_id) <= 40:
        evidence["jobId"] = job_id
    return evidence


def assert_account(auth, expected, **context):
    evidence = sanitized_auth_evidence(auth, expected, **context)
    if not auth.get("authenticated") or auth.get("challenge"):
        raise AuthenticationRequired(
            "LinkedIn needs a human sign-in or verification in the configured browser profile",
            evidence,
        )
    identities = {
        " ".join(value.casefold().split())
        for value in auth.get("identities", [])
        if isinstance(value, str) and value.strip()
    }
    if identities != {" ".join(expected.casefold().split())}:
        raise AuthenticationRequired(
            "LinkedIn account identity does not match COMPASS_LINKEDIN_EXPECTED_NAME",
            evidence,
        )


class LinkedInCollector:
    def __init__(self, app_url: str, *, browser_factory=configured_browser, mcp_factory=TaskMcp):
        self.app_url = app_url
        self.browser_factory, self.mcp_factory = browser_factory, mcp_factory

    def run(self, claim, control):
        started = time.monotonic()
        mcp = self.mcp_factory(self.app_url, claim)
        counters = {"pages": 0, "page_receipts": 0, "observed": 0, "known": 0,
                    "details": 0, "detail_acknowledgements": 0,
                    "terminal_gap_receipts": 0, "model_calls": 0}
        track_counts = {track: {"pages": 0, "details": 0} for track in ("fresh", "backfill")}
        states, stops, browser = {}, [], None
        cleanup_confirmed = True
        attempted_details = set()
        detail_lanes = {}
        phase_buckets = {}
        stopped_lanes = {track: set() for track in ("fresh", "backfill")}
        page_attempts = {track: {} for track in ("fresh", "backfill")}
        active_track = None
        active_phase = None

        def refresh(track):
            states[track] = mcp.call("get_linkedin_scan_state", track=track, **plan)
            return states[track]

        def record_stop(track, reason, lane_key=None, pending_detail_job_ids=None,
                        detail_job_id=None, **evidence):
            arguments = {"track": track, "plan_hash": states[track]["plan_hash"], "reason": reason}
            if lane_key:
                arguments["lane_key"] = lane_key
            if detail_job_id:
                arguments["detail_job_id"] = detail_job_id
            if pending_detail_job_ids:
                arguments["pending_detail_job_ids"] = pending_detail_job_ids
            states[track] = mcp.call("record_linkedin_scan_stop", **arguments)["state"]
            if reason in {"source_cap", "pagination_unverified", "detail_unavailable"}:
                counters["terminal_gap_receipts"] += 1
            stops.append({"track": track, "reason": reason, **({"lane": lane_key} if lane_key else {}), **evidence})

        def record_failure(reason, evidence=None):
            if not states or control.cancelled:
                return False
            recorded = True
            for track in states:
                try:
                    active_evidence = {
                        key: value for key, value in (evidence or {}).items()
                        if key != "track"
                    } if track == active_track else {}
                    record_stop(track, reason, **active_evidence)
                except ApiError:
                    recorded = False
            return recorded

        def result_data(**extra):
            usage = browser.usage if browser else {}
            browser_cost = measured_dollars(usage.get("browserCost")) if isinstance(usage, dict) else None
            network_cost = measured_dollars(usage.get("proxyCost")) if isinstance(usage, dict) else None
            measured_values = [value for value in (browser_cost, network_cost) if value is not None]
            measured_cost = sum(measured_values) if measured_values else None
            return {"collection": counters, "tracks": track_counts, "stops": stops,
                    "active_phase": active_phase, "browser_usage": usage,
                    "browser_cost": {"browser_usd": browser_cost,
                                     "network_usd": network_cost,
                                     "measured_total_usd": measured_cost,
                                     "network_mb": usage.get("proxyUsedMb") if isinstance(usage, dict) else None},
                    "provider_limits": {"page_size": LINKEDIN_PROVIDER_PAGE_SIZE,
                                        "max_pages_per_lane": LINKEDIN_PROVIDER_MAX_PAGES_PER_LANE,
                                        "visible_result_cap_per_lane": LINKEDIN_PROVIDER_VISIBLE_RESULT_CAP},
                    **extra}

        def failure_checkpoint(failure_result, extra_stops=()):
            return {
                "linkedin_collection": {
                    "attempt": claim.task["attemptCount"], "collected": False,
                    "activePhase": active_phase,
                    "counters": counters, "tracks": track_counts,
                    "stops": [*stops, *extra_stops],
                },
                # The failure endpoint persists checkpoints rather than task
                # results. Retain the same measured receipt shape that the
                # mixed-source router uses so LinkedIn-only failures remain
                # fully accounted without modifying retry budgets here.
                "linkedin_collection_result": failure_result,
            }

        try:
            expected = os.environ.get("COMPASS_LINKEDIN_EXPECTED_NAME", "").strip()
            if not expected:
                return AdapterResult(status="waiting_for_user", summary="Configure the expected LinkedIn account name after the interactive sign-in pilot", cleanup_confirmed=True,
                                     result=result_data(gap_recorded=False))
            context = mcp.call("get_task_context")
            plan = lane_plan(context["effectivePolicy"], context["policyHash"])
            # Every policy begins with one complete 30-day bootstrap. A task
            # that starts with an incomplete bootstrap stays in that phase even
            # if it finishes during this attempt. Only a following task may
            # initialize or resume the 1-day daily phase.
            refresh("backfill")
            if states["backfill"].get("settled") is True:
                refresh("fresh")
                active_track, active_phase = "fresh", "daily_1d"
            else:
                active_track, active_phase = "backfill", "bootstrap_30d"
            budgets = claim.task.get("payload", {}).get("budgets", {})
            max_pages = int(budgets.get("maxPages", 10))
            max_details = int(budgets.get("maxDetailFetches", 30))
            max_seconds = int(budgets.get("maxDurationSeconds", 1200))

            def active():
                if control.cancelled:
                    raise BrowserError("Compass lease lost")
                return time.monotonic() - started < max_seconds - 15

            def ingest(items, label):
                if not items:
                    return
                observed = utc_now()
                digest = hashlib.sha256(json.dumps({"items": items, "at": observed}, sort_keys=True).encode()).hexdigest()[:24]
                run_key = f"task:{claim.id}:{label}:{digest}"
                candidate_id = claim.task.get("payload", {}).get("candidateId")
                if not isinstance(candidate_id, str) or not candidate_id.strip():
                    raise ValueError("Task payload is missing a candidateId")
                batch_items = [{**item, "candidateId": candidate_id, "source": "linkedin",
                                "collectorRunKey": run_key, "firstObservedAt": observed} for item in items]
                return mcp.call("ingest_linkedin_batch", batch={"schemaVersion": 1, "candidateId": candidate_id,
                                "runKey": run_key, "generatedAt": observed, "items": batch_items})

            def compact(row, lane=None):
                item = {"jobId": row["jobId"], "canonicalUrl": f"https://www.linkedin.com/jobs/view/{row['jobId']}/",
                        "title": row["title"][:500], "compact": {"text": row.get("text", "")},
                        "funnelState": "discovered_compact"}
                for key, maximum in (("company", 300), ("location", 1000), ("workMode", 120)):
                    if row.get(key) and len(row[key]) <= maximum:
                        item[key] = row[key]
                if lane:
                    item["lane"] = lane
                return item

            def progress():
                if not control.report_progress(checkpoint={"linkedin_collection": {
                        "attempt": claim.task["attemptCount"], "collected": False,
                        "planHash": states[active_track]["plan_hash"], "activePhase": active_phase,
                        "counters": counters, "tracks": track_counts}},
                        message=f"LinkedIn: {counters['pages']} pages, {counters['details']} detail reads"):
                    raise BrowserError("Compass could not persist collection progress")

            def scan_pages(track, *, page_limit):
                # The server orders fresh lanes by their last actual observation.
                # Balance attempts across lanes even when this track is resumed in
                # a later phase of the same run.
                lane_keys = [lane["lane_key"] for lane in states[track]["lanes"]]
                lane_order = {lane_key: index for index, lane_key in enumerate(lane_keys)}
                while active() and counters["pages"] < page_limit:
                    advanced = False
                    ordered_keys = sorted(
                        lane_keys,
                        key=lambda lane_key: (
                            page_attempts[track].get(lane_key, 0), lane_order[lane_key]
                        ),
                    )
                    for lane_key in ordered_keys:
                        if counters["pages"] >= page_limit or not active():
                            return
                        state = states[track]
                        lane = next(lane for lane in state["lanes"] if lane["lane_key"] == lane_key)
                        if (lane["exhausted"] or lane_key in stopped_lanes[track]
                                or lane.get("stop_reason") in {"source_cap", "pagination_unverified"}):
                            continue
                        if lane["next_page"] > LINKEDIN_PROVIDER_MAX_PAGES_PER_LANE:
                            record_stop(track, "source_cap", lane_key)
                            stopped_lanes[track].add(lane_key)
                            continue
                        counters["pages"] += 1
                        track_counts[track]["pages"] += 1
                        page_attempts[track][lane_key] = page_attempts[track].get(lane_key, 0) + 1
                        page = browser.command("search", url=page_url(lane, state))
                        assert_account(page.get("auth", {}), expected,
                                       operation="search", track=track, lane_key=lane_key)
                        rows = page.get("items", [])
                        ids = [row["jobId"] for row in rows]
                        if ids and set(ids) == set(lane.get("last_page_job_ids", [])):
                            record_stop(track, "pagination_unverified", lane_key, detail="repeated_page")
                            stopped_lanes[track].add(lane_key)
                            continue
                        known = mcp.call("lookup_linkedin_jobs", job_ids=ids)["jobs"] if ids else []
                        pending = [item["jobId"] for item in known if item["shouldFetch"]]
                        for pending_job_id in pending:
                            detail_lanes.setdefault(pending_job_id, lane_key)
                        counters["known"] += sum(bool(item["known"]) for item in known)
                        counters["observed"] += len(ids)
                        ingest([compact(row, lane_key) for row in rows], track + ":page")
                        source_cap = page.get("stopReason") == "source_cap"
                        if (page.get("stopReason") and not source_cap) or not page.get("fullyLoaded"):
                            record_stop(track, "pagination_unverified", lane_key,
                                        pending_detail_job_ids=pending,
                                        detail=page.get("stopReason") or "page_not_fully_loaded",
                                        verification=page.get("verification"), footer=page.get("footer"))
                            stopped_lanes[track].add(lane_key)
                            continue
                        arguments = {"track": track, "plan_hash": state["plan_hash"], "lane_key": lane_key,
                                     "page": lane["next_page"], "page_complete": True, "job_ids": ids,
                                     "pending_detail_job_ids": pending, "exhausted": bool(page["exhausted"])}
                        if lane.get("next_cursor"):
                            arguments["source_cursor"] = lane["next_cursor"]
                        if not page["exhausted"]:
                            arguments["next_cursor"] = str(lane["next_page"] * LINKEDIN_PROVIDER_PAGE_SIZE)
                        states[track] = mcp.call("record_linkedin_scan_page", **arguments)["state"]
                        counters["page_receipts"] += 1
                        phase_buckets.setdefault(lane_key, []).extend(pending)
                        advanced = True
                        if source_cap:
                            record_stop(track, "source_cap", lane_key)
                            stopped_lanes[track].add(lane_key)
                        progress()
                    if not advanced:
                        break

            def drain_details(track, *, limit, include_backlog=False, priorities=()):
                priority = list(dict.fromkeys(priorities))
                while counters["details"] < limit and active():
                    state = states[track]
                    ids = [*priority, *state.get("pending_detail_job_ids", [])]
                    if include_backlog:
                        ids.extend(state.get("backlog_pending_detail_job_ids", []))
                    remaining = [job_id for job_id in dict.fromkeys(ids) if job_id not in attempted_details]
                    if not remaining:
                        break
                    job_id = remaining[0]
                    attempted_details.add(job_id)
                    known = mcp.call("lookup_linkedin_jobs", job_ids=[job_id])["jobs"][0]
                    if known["shouldFetch"]:
                        counters["details"] += 1
                        track_counts[track]["details"] += 1
                        detail = browser.command("details", jobId=job_id)
                        assert_account(detail.get("auth", {}), expected,
                                       operation="detail", track=track,
                                       lane_key=detail_lanes.get(job_id), job_id=job_id)
                        actual = urlsplit(detail.get("sourceUrl", ""))
                        if actual.scheme != "https" or actual.hostname not in {"linkedin.com", "www.linkedin.com"} or actual.path.rstrip("/") != f"/jobs/view/{job_id}":
                            record_stop(track, "detail_unavailable", detail_job_id=job_id,
                                        jobId=job_id, detail="detail_identity_mismatch")
                            continue
                        if not detail.get("title") or not detail.get("company") or not detail.get("description") or len(detail["description"]) > 100_000:
                            record_stop(track, "detail_unavailable", detail_job_id=job_id,
                                        jobId=job_id, detail="detail_evidence_unavailable")
                            continue
                        item = compact({**detail, "jobId": job_id})
                        if "company" not in item:
                            record_stop(track, "detail_unavailable", detail_job_id=job_id,
                                        jobId=job_id, detail="company_identity_unavailable")
                            continue
                        item.update({"funnelState": "snapshot_ready", "snapshot": {
                            "description": detail["description"], "sourceUrl": item["canonicalUrl"],
                            "workModeText": item.get("workMode"), "closed": bool(detail.get("closed"))},
                            "titleDecision": {"decision": "defer_to_evaluator", "method": "no_title_filter"},
                            "detailDecision": {"decision": "evaluate_full_evidence", "method": "dom_capture"}})
                        ingest([item], track + ":detail")
                    # A full snapshot committed before a crash is acknowledged
                    # without another browser read. Server validation covers all
                    # compatible pending rows, including older fresh attempts.
                    states[track] = mcp.call("record_linkedin_scan_details", track=track,
                        plan_hash=state["plan_hash"], job_ids=[job_id])["state"]
                    counters["detail_acknowledgements"] += 1
                    progress()

            if active() and (max_pages > 0 or max_details > 0):
                cleanup_confirmed = False
                browser = self.browser_factory(control=control, minutes=min(60, math.ceil(max_seconds / 60) + 2),
                                               block_media=os.environ.get("COMPASS_LINKEDIN_BLOCK_MEDIA", "") == "1")

                @contextmanager
                def owned_browser():
                    nonlocal cleanup_confirmed
                    browser.__enter__()
                    try:
                        yield browser
                    finally:
                        browser.__exit__(*sys.exc_info())
                        cleanup_confirmed = True

                with owned_browser():
                    # Finish the active phase's existing evidence queue, traverse
                    # every resumable lane frontier allowed by explicit limits,
                    # then drain newly discovered evidence. Repeated state refreshes
                    # expose further 300-ID transport chunks until no work remains.
                    drain_details(active_track, limit=max_details, include_backlog=True)
                    scan_pages(active_track, page_limit=max_pages)
                    queues = list(phase_buckets.values())
                    priorities = [queue[index] for index in range(max(map(len, queues), default=0))
                                  for queue in queues if index < len(queue)]
                    drain_details(active_track, limit=max_details, include_backlog=True,
                                  priorities=priorities)

            refresh(active_track)
            if counters["pages"] >= max_pages and not states[active_track]["collection_complete"]:
                record_stop(active_track, "page_budget")
            if not active():
                record_stop(active_track, "time_budget")
            if counters["details"] >= max_details and (states[active_track].get("pending_detail_count") or states[active_track].get("backlog_pending_detail_count")):
                record_stop(active_track, "detail_budget")
            state = states[active_track]
            complete = state["complete"]
            unfinished_lanes = [lane for lane in state["lanes"] if not lane["exhausted"]]
            pending_work = bool(state.get("pending_detail_count") or state.get("backlog_pending_detail_count"))
            terminal_lane_reasons = {"source_cap", "pagination_unverified"}
            lanes_blocked = bool(unfinished_lanes) and all(
                lane.get("stop_reason") in terminal_lane_reasons for lane in unfinished_lanes
            )
            resumable_lanes = any(
                lane.get("stop_reason") not in terminal_lane_reasons for lane in unfinished_lanes
            )
            actual_progress = bool(counters["page_receipts"] or counters["detail_acknowledgements"]
                                   or counters["terminal_gap_receipts"])
            resume_required = not complete and actual_progress and (pending_work or resumable_lanes)
            provider_blocked = not complete and lanes_blocked and not pending_work
            summary = (f"LinkedIn {active_phase} {'UI-reported lane traversal finished' if complete else 'scan incomplete; durable gaps retained'}: "
                       f"{counters['pages']} pages, {counters['observed']} observations, {counters['details']} detail reads. "
                       "Evaluations may still be pending.")
            checkpoint = {"linkedin_collection": {"attempt": claim.task["attemptCount"], "collected": True,
                          "planHash": state["plan_hash"], "activePhase": active_phase,
                          "phaseComplete": complete, "phaseSettled": state.get("settled") is True,
                          "resumeRequired": resume_required,
                          "counters": counters, "tracks": track_counts, "stops": stops}}
            if not control.report_progress(checkpoint=checkpoint, message=summary):
                raise BrowserError("Compass could not persist collection progress")
            return AdapterResult(status="succeeded", summary=summary, checkpoint=checkpoint, cleanup_confirmed=cleanup_confirmed,
                result=result_data(status="succeeded" if complete else "partial", gap_recorded=True,
                    phase_complete=complete, resume_required=resume_required,
                    phase_settled=state.get("settled") is True,
                    provider_blocked=provider_blocked, gaps=state.get("gaps", []),
                    coverage_claim="IDs observed on fetched LinkedIn pages; live offset changes and source caps prevent exhaustive coverage guarantees"))
        except AuthenticationRequired as error:
            recorded = record_failure("authentication_required", error.evidence)
            failure_result = result_data(gap_recorded=recorded,
                resume_required=False, provider_blocked=True,
                block_reason="authentication_required")
            return AdapterResult(status="waiting_for_user", summary=str(error), cleanup_confirmed=cleanup_confirmed,
                                 checkpoint=failure_checkpoint(failure_result), result=failure_result)
        except ValueError as error:
            recorded = record_failure("authentication_required")
            failure_result = result_data(gap_recorded=recorded,
                resume_required=False, provider_blocked=True,
                block_reason="configuration_required")
            return AdapterResult(status="waiting_for_user", summary=str(error), cleanup_confirmed=cleanup_confirmed,
                                 checkpoint=failure_checkpoint(failure_result), result=failure_result)
        except CloudLifecycleUncertain as error:
            recorded = record_failure("browser_unavailable")
            failure_result = result_data(gap_recorded=recorded, browser_id=error.browser_id,
                resume_required=False, provider_blocked=True,
                block_reason="browser_unavailable")
            return AdapterResult(status="waiting_for_user", summary=str(error), cleanup_confirmed=False,
                                 checkpoint=failure_checkpoint(failure_result,
                                     [{"reason": "cloud_lifecycle_uncertain", "browserId": error.browser_id}]),
                                 result=failure_result)
        except BrowserError as error:
            recorded = record_failure("browser_unavailable")
            failure_result = result_data(gap_recorded=recorded,
                resume_required=False, provider_blocked=True,
                block_reason="browser_unavailable")
            return AdapterResult(status="failed", summary=str(error), retryable=not control.cancelled,
                                 cleanup_confirmed=cleanup_confirmed,
                                 checkpoint=failure_checkpoint(failure_result), result=failure_result)
        except ApiError as error:
            recorded = record_failure("browser_unavailable")
            failure_result = result_data(gap_recorded=recorded,
                resume_required=False, provider_blocked=False,
                block_reason="app_api_error")
            return AdapterResult(status="failed", summary=str(error), retryable=error.retryable,
                                 cleanup_confirmed=cleanup_confirmed,
                                 checkpoint=failure_checkpoint(failure_result), result=failure_result)

class SearchRoutingAdapter:
    """Use deterministic collection for LinkedIn and Hermes for semantic work."""
    _PUBLIC_RESERVE_RATIO = 0.20
    _MIN_PUBLIC_SECONDS = 60

    def __init__(self, app_url, hermes, *, clock=time.monotonic):
        self.hermes = hermes
        self.collector = LinkedInCollector(app_url)
        self._clock = clock

    @staticmethod
    def _budget(task, name, default):
        budgets = task.get("payload", {}).get("budgets", {})
        value = budgets.get(name, default) if isinstance(budgets, dict) else default
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            return default
        return value

    @staticmethod
    def _with_budgets(claim, budgets):
        task = dict(claim.task)
        payload = dict(task.get("payload", {}))
        payload["budgets"] = budgets
        task["payload"] = payload
        return TaskClaim(
            task,
            claim.claim_token,
            claim.lease_expires_at,
            claim.heartbeat_interval_seconds,
        )

    @staticmethod
    def _used(collection, name):
        counters = collection.result.get("collection", {})
        value = counters.get(name, 0) if isinstance(counters, dict) else 0
        return (
            value
            if isinstance(value, int) and not isinstance(value, bool) and value > 0
            else 0
        )

    def run(self, claim, control):
        sources = claim.task.get("payload", {}).get("sources", [])
        if claim.task.get("kind") != "search" or "linkedin" not in sources:
            return self.hermes.run(claim, control)
        if "public" not in sources:
            return self.collector.run(claim, control)

        initial = {
            "maxPages": self._budget(claim.task, "maxPages", 10),
            "maxDetailFetches": self._budget(claim.task, "maxDetailFetches", 30),
            "maxDurationSeconds": self._budget(claim.task, "maxDurationSeconds", 1200),
        }
        page_reserve = min(
            initial["maxPages"],
            max(1, math.ceil(initial["maxPages"] * self._PUBLIC_RESERVE_RATIO)),
        )
        time_reserve = min(
            initial["maxDurationSeconds"],
            max(1, math.ceil(initial["maxDurationSeconds"] * self._PUBLIC_RESERVE_RATIO)),
        )
        linkedin_limit = {
            "maxPages": max(0, initial["maxPages"] - page_reserve),
            # Public discovery and LinkedIn collection count different work.
            # Do not turn the shared setting into an arbitrary 80% LinkedIn
            # description quota (historically 24 of 30).
            "maxDetailFetches": initial["maxDetailFetches"],
            "maxDurationSeconds": max(0, initial["maxDurationSeconds"] - time_reserve),
        }
        collection_claim = self._with_budgets(claim, linkedin_limit)
        started = self._clock()
        collection = self.collector.run(collection_claim, control)
        elapsed = max(0, math.ceil(self._clock() - started))
        partial = collection.status != "succeeded"
        if partial and not (collection.cleanup_confirmed and not control.cancelled and
                            collection.result.get("gap_recorded") is True):
            return collection
        if collection.status == "failed" and collection.retryable:
            return collection

        used = {
            "pages": self._used(collection, "pages"),
            "details": self._used(collection, "details"),
            "durationSeconds": elapsed,
        }
        remaining = {
            "maxPages": max(0, initial["maxPages"] - used["pages"]),
            "maxDetailFetches": max(0, initial["maxDetailFetches"] - used["details"]),
            "maxDurationSeconds": max(0, initial["maxDurationSeconds"] - elapsed),
        }
        budget_checkpoint = {
            "initial": initial,
            "linkedinLimit": linkedin_limit,
            "linkedinUsed": used,
            "remaining": remaining,
        }
        task = dict(claim.task)
        task["checkpoint"] = {
            **task.get("checkpoint", {}),
            **(collection.checkpoint or {}),
            # A later public-web failure is finalized through the worker's
            # failure endpoint, which persists checkpoints but not result data.
            # Retain the stopped browser receipt and collection outcome before
            # handing the remaining budget to Hermes.
            "linkedin_collection_result": collection.result,
            "public_search_remaining_budget": budget_checkpoint,
        }
        if partial:
            task["checkpoint"]["linkedin_collection"] = {
                "attempt": claim.task["attemptCount"], "collected": False,
                "stage_finished": True,
                "status": collection.status, "summary": collection.summary,
                "counters": collection.result.get("collection", {}),
                "stops": collection.result.get("stops", []),
            }
        payload = dict(task.get("payload", {}))
        payload["budgets"] = remaining
        task["payload"] = payload

        if not control.report_progress(
            checkpoint=task["checkpoint"],
            message=(
                "LinkedIn collection stage finished; recorded the shared budget remaining "
                "for public-web search."
            ),
        ):
            return AdapterResult(
                status="failed",
                summary="Could not persist the shared budget before public-web search.",
                checkpoint=task["checkpoint"],
                result={"linkedin_collection": collection.result},
                retryable=not control.cancelled,
                cleanup_confirmed=collection.cleanup_confirmed,
            )

        if (
            remaining["maxPages"] < 1
            or remaining["maxDetailFetches"] < 1
            or remaining["maxDurationSeconds"] < self._MIN_PUBLIC_SECONDS
        ):
            return AdapterResult(
                status=collection.status if partial else "succeeded",
                cleanup_confirmed=collection.cleanup_confirmed,
                summary=(
                    f"{collection.summary} Public-web search was skipped because the shared "
                    "remaining budget was insufficient."
                ),
                checkpoint=task["checkpoint"],
                result={
                    "status": "partial" if partial else "succeeded",
                    "linkedin_collection": collection.result,
                    "public_web": {
                        "status": "skipped",
                        "reason": "insufficient_remaining_budget",
                        "remaining_budget": remaining,
                    },
                },
            )

        staged_claim = TaskClaim(
            task,
            claim.claim_token,
            claim.lease_expires_at,
            claim.heartbeat_interval_seconds,
        )
        semantic = self.hermes.run(staged_claim, control)
        public_result = dict(semantic.result)
        public_summary = semantic.summary
        semantic.cleanup_confirmed = collection.cleanup_confirmed and semantic.cleanup_confirmed
        semantic.result = {**semantic.result, "linkedin_collection": collection.result}
        if partial:
            semantic.result.update({"status": "partial", "linkedin_status": collection.status,
                                    "linkedin_summary": collection.summary})
        elif collection.result.get("status") == "partial":
            semantic.result["status"] = "partial"
        semantic.summary = f"{semantic.summary} {collection.summary}"
        semantic.checkpoint = {
            **(semantic.checkpoint or {}),
            **task["checkpoint"],
        }
        if (collection.status == "succeeded" and semantic.status != "succeeded"
                and semantic.cleanup_confirmed):
            public_status = "blocked" if semantic.status == "waiting_for_user" else "failed"
            return AdapterResult(
                status="succeeded",
                summary=f"{collection.summary} Public-web stage {public_status}: {public_summary}",
                checkpoint=semantic.checkpoint,
                cleanup_confirmed=True,
                result={
                    "status": "partial",
                    "linkedin_collection": collection.result,
                    "public_web": {
                        **public_result,
                        "status": public_status,
                        "summary": public_summary,
                        "retryable": semantic.retryable,
                    },
                },
            )
        return semantic
