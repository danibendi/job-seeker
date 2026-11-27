import { describe, expect, it } from "vitest";
import {
  computeAssistantStatus,
  getMostRecentElapsedDueOccurrence,
  getNextScheduledSearch,
  interruptedRequestIdsFor,
  isInterruptedTask,
  resolveScheduledInstant,
  roleQuestionStatusLabel,
  type AssistantStatusInput,
} from "../src/lib/assistant-status";
import type { SearchSchedule } from "../src/lib/settings";

const WEEKDAYS_0900: SearchSchedule = {
  enabled: true,
  frequency: "weekdays",
  time: "09:00",
  days: [],
  maxJobs: 15,
};

function baseInput(overrides: Partial<AssistantStatusInput> = {}): AssistantStatusInput {
  // Thursday 26 Nov 2026, 10:20 Europe/London (UTC+0 in November)
  const now = new Date("2026-11-26T10:20:00Z");
  return {
    assistantLabel: "Orbit",
    timeZone: "Europe/London",
    now,
    chosenExecutors: ["codex", "codex"],
    registeredWorkers: [{ id: "codex-main", executor: "codex" }],
    workerContacts: [{ workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-26T10:19:30Z") }],
    workerPauses: [],
    runningTasks: [],
    waitingRequests: 0,
    lastSuccessfulSearchAt: new Date("2026-11-26T09:01:00Z"),
    schedule: WEEKDAYS_0900,
    hasElapsedScheduleOccurrence: true,
    ...overrides,
  };
}

describe("assistant status derivation", () => {
  it("reports ready with last successful search and next scheduled search", () => {
    const status = computeAssistantStatus(baseInput());
    expect(status).toMatchObject({
      state: "ready",
      tone: "good",
      title: "Orbit is ready",
      meta: "Last search today 09:01 · Next Fri 09:00",
      waitReason: null,
      tailoringWaitLabel: "CV tailoring waiting",
    });
  });

  it("reports working for searching, answering a question, and scoring a role", () => {
    const now = new Date("2026-11-26T10:20:00Z");
    const taskBase = {
      id: "t-1",
      executor: "codex" as const,
      status: "running",
      requestId: "r-1",
      claimedBy: "codex-main",
      leaseExpiresAt: new Date("2026-11-26T10:22:00Z"),
      startedAt: new Date("2026-11-26T10:18:00Z"),
      updatedAt: new Date("2026-11-26T10:18:00Z"),
      createdAt: new Date("2026-11-26T10:18:00Z"),
    };

    const answering = computeAssistantStatus(baseInput({
      now,
      runningTasks: [{ ...taskBase, kind: "question" }],
      waitingRequests: 2,
    }));
    expect(answering).toMatchObject({
      state: "working",
      tone: "brand",
      title: "Orbit is answering a question",
      meta: "Started 10:18 · 1 more request waiting",
    });

    const searching = computeAssistantStatus(baseInput({
      now,
      runningTasks: [{ ...taskBase, kind: "search" }],
      waitingRequests: 1,
    }));
    expect(searching).toMatchObject({
      state: "working",
      tone: "brand",
      title: "Orbit is searching for roles",
      meta: "Started 10:18",
    });

    const scoring = computeAssistantStatus(baseInput({
      now,
      runningTasks: [{ ...taskBase, kind: "linkedin_evaluate", requestId: null }],
      waitingRequests: 0,
    }));
    expect(scoring).toMatchObject({
      state: "working",
      tone: "brand",
      title: "Orbit is scoring a role",
      meta: "Started 10:18",
    });
  });

  it("treats 15 minutes without contact as offline and wins over missed search and paused workers", () => {
    const now = new Date("2026-11-26T10:20:00Z");
    // 14m 59s is still online
    const stillOnline = computeAssistantStatus(baseInput({
      now,
      workerContacts: [{ workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-26T10:05:01Z") }],
    }));
    expect(stillOnline.state).toBe("ready");

    // Exactly 15m is offline, even when a scheduled search was also missed
    const offline = computeAssistantStatus(baseInput({
      now,
      workerContacts: [{ workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-24T14:05:00Z") }],
      waitingRequests: 2,
      lastSuccessfulSearchAt: new Date("2026-11-24T09:01:00Z"),
      hasElapsedScheduleOccurrence: false,
    }));
    expect(offline).toMatchObject({
      state: "offline",
      tone: "bad",
      title: "Orbit is offline",
      meta: "Last seen Tue 14:05 · 2 requests waiting",
      waitReason: "Orbit is offline",
      tailoringWaitLabel: "CV tailoring waiting · Orbit is offline",
    });

    // Multi-executor: least healthy executor wins (codex online, hermes offline -> offline)
    const mixed = computeAssistantStatus(baseInput({
      now,
      chosenExecutors: ["codex", "hermes"],
      registeredWorkers: [
        { id: "codex-main", executor: "codex" },
        { id: "hermes-eval", executor: "hermes" },
      ],
      workerContacts: [
        { workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-26T10:19:45Z") },
        { workerId: "hermes-eval", executor: "hermes", lastSeenAt: new Date("2026-11-26T09:00:00Z") },
      ],
    }));
    expect(mixed).toMatchObject({
      state: "offline",
      meta: "Last seen today 09:00",
    });

    // Redundant workers on the same executor: one offline worker does not mark the executor offline
    // or hide an active task running on the healthy sibling worker.
    const redundantOnlineWorking = computeAssistantStatus(baseInput({
      now,
      chosenExecutors: ["codex", "codex"],
      registeredWorkers: [
        { id: "codex-a", executor: "codex" },
        { id: "codex-b", executor: "codex" },
      ],
      workerContacts: [
        { workerId: "codex-a", executor: "codex", lastSeenAt: new Date("2026-11-26T09:00:00Z") },
        { workerId: "codex-b", executor: "codex", lastSeenAt: new Date("2026-11-26T10:19:45Z") },
      ],
      runningTasks: [{
        id: "t-redundant",
        kind: "search",
        executor: "codex",
        status: "running",
        requestId: "r-1",
        claimedBy: "codex-b",
        leaseExpiresAt: new Date("2026-11-26T10:22:00Z"),
        startedAt: new Date("2026-11-26T10:18:00Z"),
        updatedAt: new Date("2026-11-26T10:18:00Z"),
        createdAt: new Date("2026-11-26T10:18:00Z"),
      }],
    }));
    expect(redundantOnlineWorking).toMatchObject({
      state: "working",
      title: "Orbit is searching for roles",
    });

    // When all redundant workers for an executor are offline, report the most recent contact for that executor
    const allRedundantOffline = computeAssistantStatus(baseInput({
      now,
      chosenExecutors: ["codex", "codex"],
      registeredWorkers: [
        { id: "codex-a", executor: "codex" },
        { id: "codex-b", executor: "codex" },
      ],
      workerContacts: [
        { workerId: "codex-a", executor: "codex", lastSeenAt: new Date("2026-11-26T08:00:00Z") },
        { workerId: "codex-b", executor: "codex", lastSeenAt: new Date("2026-11-26T09:30:00Z") },
      ],
    }));
    expect(allRedundantOffline).toMatchObject({
      state: "offline",
      meta: "Last seen today 09:30",
    });
  });

  it("reports paused only when a configured executor has no usable unpaused worker", () => {
    const status = computeAssistantStatus(baseInput({
      workerPauses: [{
        workerId: "codex-main",
        executor: "codex",
        reason: "usage_limit",
        pausedAt: new Date("2026-11-26T09:40:00Z"),
      }],
      waitingRequests: 2,
    }));
    expect(status).toMatchObject({
      state: "paused",
      tone: "warn",
      title: "Orbit is paused",
      meta: "Usage limit reached · 2 requests waiting",
      waitReason: "Orbit is paused",
      tailoringWaitLabel: "CV tailoring waiting · Orbit is paused",
    });

    // Another fresh unpaused worker for the same executor keeps the assistant available/working
    const now = new Date("2026-11-26T10:20:00Z");
    const redundantUnpaused = computeAssistantStatus(baseInput({
      now,
      chosenExecutors: ["codex", "codex"],
      registeredWorkers: [
        { id: "codex-a", executor: "codex" },
        { id: "codex-b", executor: "codex" },
      ],
      workerContacts: [
        { workerId: "codex-a", executor: "codex", lastSeenAt: new Date("2026-11-26T10:19:30Z") },
        { workerId: "codex-b", executor: "codex", lastSeenAt: new Date("2026-11-26T10:19:45Z") },
      ],
      workerPauses: [{
        workerId: "codex-a",
        executor: "codex",
        reason: "usage_limit",
        pausedAt: new Date("2026-11-26T09:40:00Z"),
      }],
      runningTasks: [{
        id: "t-sibling",
        kind: "question",
        executor: "codex",
        status: "running",
        requestId: "r-1",
        claimedBy: "codex-b",
        leaseExpiresAt: new Date("2026-11-26T10:22:00Z"),
        startedAt: new Date("2026-11-26T10:18:00Z"),
        updatedAt: new Date("2026-11-26T10:18:00Z"),
        createdAt: new Date("2026-11-26T10:18:00Z"),
      }],
    }));
    expect(redundantUnpaused).toMatchObject({
      state: "working",
      title: "Orbit is answering a question",
    });

    // If one sibling is paused and the other is offline, no usable worker remains -> paused
    const pausedWithOfflineSibling = computeAssistantStatus(baseInput({
      now,
      chosenExecutors: ["codex", "codex"],
      registeredWorkers: [
        { id: "codex-a", executor: "codex" },
        { id: "codex-b", executor: "codex" },
      ],
      workerContacts: [
        { workerId: "codex-a", executor: "codex", lastSeenAt: new Date("2026-11-26T10:19:30Z") },
        { workerId: "codex-b", executor: "codex", lastSeenAt: new Date("2026-11-26T09:00:00Z") },
      ],
      workerPauses: [{
        workerId: "codex-a",
        executor: "codex",
        reason: "usage_limit",
        pausedAt: new Date("2026-11-26T09:40:00Z"),
      }],
    }));
    expect(pausedWithOfflineSibling.state).toBe("paused");
  });

  it("reports a missed scheduled search after one hour, naming the weekday when not today", () => {
    // Today 09:59 (59m after 09:00) -> yesterday's occurrence ran, today is still in grace window -> ready
    const inGrace = computeAssistantStatus(baseInput({
      now: new Date("2026-11-26T09:59:00Z"),
      workerContacts: [{ workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-26T09:58:30Z") }],
      lastSuccessfulSearchAt: new Date("2026-11-25T09:01:00Z"),
      hasElapsedScheduleOccurrence: true, // Wednesday's occurrence exists
    }));
    expect(inGrace.state).toBe("ready");

    // Today 10:00 (1 hour after 09:00) with no occurrence -> today's missed search headline
    const missedToday = computeAssistantStatus(baseInput({
      now: new Date("2026-11-26T10:00:00Z"),
      workerContacts: [{ workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-26T09:59:30Z") }],
      lastSuccessfulSearchAt: new Date("2026-11-25T09:01:00Z"),
      hasElapsedScheduleOccurrence: false,
    }));
    expect(missedToday).toMatchObject({
      state: "missed",
      tone: "warn",
      title: "09:00 search didn’t start",
      meta: "Last search yesterday 09:01",
    });

    // Previous day missed (e.g. Thursday 08:30, Wednesday 09:00 didn't start) -> names the day ("Wed 09:00...")
    const missedYesterday = computeAssistantStatus(baseInput({
      now: new Date("2026-11-26T08:30:00Z"),
      workerContacts: [{ workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-26T08:29:30Z") }],
      lastSuccessfulSearchAt: new Date("2026-11-24T09:01:00Z"),
      hasElapsedScheduleOccurrence: false,
    }));
    expect(missedYesterday).toMatchObject({
      state: "missed",
      tone: "warn",
      title: "Wed 09:00 search didn’t start",
      meta: "Last search Tue 09:01",
    });

    // Manual search completed after the missed time clears the missed headline
    const clearedByManual = computeAssistantStatus(baseInput({
      now: new Date("2026-11-26T10:30:00Z"),
      workerContacts: [{ workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-26T10:29:30Z") }],
      lastSuccessfulSearchAt: new Date("2026-11-26T10:24:00Z"),
      hasElapsedScheduleOccurrence: false,
    }));
    expect(clearedByManual).toMatchObject({
      state: "ready",
      title: "Orbit is ready",
      meta: "Last search today 10:24 · Next Fri 09:00",
    });
  });

  it("reports no assistant connected when no worker matches chosen executors", () => {
    const none = computeAssistantStatus(baseInput({
      registeredWorkers: [],
      waitingRequests: 2,
    }));
    expect(none).toMatchObject({
      state: "none",
      tone: "neutral",
      title: "No assistant connected",
      meta: "2 requests waiting",
      waitReason: "no assistant connected",
      tailoringWaitLabel: "CV tailoring waiting · no assistant",
    });

    // Registered worker for a different executor than chosen in Settings -> Schedule
    const mismatch = computeAssistantStatus(baseInput({
      chosenExecutors: ["codex", "unassigned"],
      registeredWorkers: [{ id: "hermes-1", executor: "hermes" }],
    }));
    expect(mismatch.state).toBe("none");

    // Partial coverage: one configured executor has an online worker, another lacks any worker
    const partial = computeAssistantStatus(baseInput({
      chosenExecutors: ["codex", "hermes"],
      executorAssignments: { search: "codex", evaluation: "hermes" },
      registeredWorkers: [{ id: "hermes-1", executor: "hermes" }],
      workerContacts: [{ workerId: "hermes-1", executor: "hermes", lastSeenAt: new Date("2026-11-26T10:19:30Z") }],
      waitingRequests: 2,
    }));
    expect(partial).toMatchObject({
      state: "incomplete",
      tone: "warn",
      title: "No Codex worker connected",
      meta: "Assigned to searches and questions · 2 requests waiting",
      waitReason: "no Codex worker connected",
      tailoringWaitLabel: "CV tailoring waiting · no Codex worker",
    });

    // Offline connected worker still wins over missing worker for another executor
    const partialOffline = computeAssistantStatus(baseInput({
      chosenExecutors: ["codex", "hermes"],
      executorAssignments: { search: "codex", evaluation: "hermes" },
      registeredWorkers: [{ id: "hermes-1", executor: "hermes" }],
      workerContacts: [{ workerId: "hermes-1", executor: "hermes", lastSeenAt: new Date("2026-11-26T09:00:00Z") }],
    }));
    expect(partialOffline.state).toBe("offline");
  });

  it("treats running tasks with expired leases as interrupted, not working", () => {
    const now = new Date("2026-11-26T10:25:00Z");
    const expiredTask = {
      id: "t-exp",
      kind: "question" as const,
      executor: "codex" as const,
      status: "running",
      requestId: "req-1",
      claimedBy: "codex-main",
      leaseExpiresAt: new Date("2026-11-26T10:22:00Z"),
      startedAt: new Date("2026-11-26T10:20:00Z"),
      updatedAt: new Date("2026-11-26T10:20:00Z"),
      createdAt: new Date("2026-11-26T10:20:00Z"),
    };

    expect(isInterruptedTask(expiredTask, now)).toBe(true);
    expect(interruptedRequestIdsFor([{ id: "req-1", status: "in_progress" }], [expiredTask], now)).toEqual(["req-1"]);

    // Worker stopped 3 minutes ago (< 15 min offline), lease expired -> not "working" anymore
    const status = computeAssistantStatus(baseInput({
      now,
      workerContacts: [{ workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-26T10:22:00Z") }],
      runningTasks: [expiredTask],
      waitingRequests: 1,
    }));
    expect(status.state).toBe("ready");

    // Role question label flips from "Orbit is working on it" to "Waiting" once lease expires
    expect(roleQuestionStatusLabel({ id: "req-1", status: "in_progress", errorMd: null }, status, new Set(["req-1"]))).toBe("Waiting");

    // Once worker is offline, role question label explains why
    const offlineStatus = computeAssistantStatus(baseInput({
      now: new Date("2026-11-26T10:40:00Z"),
      workerContacts: [{ workerId: "codex-main", executor: "codex", lastSeenAt: new Date("2026-11-26T10:22:00Z") }],
      runningTasks: [expiredTask],
      waitingRequests: 1,
    }));
    expect(roleQuestionStatusLabel({ id: "req-1", status: "in_progress", errorMd: null }, offlineStatus, new Set(["req-1"]))).toBe("Waiting · Orbit is offline");
  });

  it("handles schedule lookup across weekends and DST transitions without throwing", () => {
    // Saturday 11:00 -> most recent elapsed weekday due time is Friday 09:00; next is Monday 09:00
    const saturday = new Date("2026-11-28T11:00:00Z");
    const due = getMostRecentElapsedDueOccurrence(WEEKDAYS_0900, "Europe/London", saturday);
    expect(due?.localDate).toBe("2026-11-27");
    expect(due?.weekday).toBe("Fri");

    const next = getNextScheduledSearch(WEEKDAYS_0900, "Europe/London", saturday);
    expect(next?.localDate).toBe("2026-11-30");
    expect(next?.weekday).toBe("Mon");

    // DST spring-forward gap in Europe/Prague (2026-03-29 02:30 doesn't exist; clocks jump 02:00 -> 03:00)
    const gap = resolveScheduledInstant("2026-03-29", "02:30", "Europe/Prague");
    expect(Number.isFinite(gap.getTime())).toBe(true);
    expect(gap.toISOString()).toBe("2026-03-29T01:00:00.000Z");

    // DST autumn fold in Europe/Prague (2026-10-25 02:30 occurs twice; first is CEST = 00:30Z)
    const fold = resolveScheduledInstant("2026-10-25", "02:30", "Europe/Prague");
    expect(fold.toISOString()).toBe("2026-10-25T00:30:00.000Z");

    // Non-one-hour DST autumn fold in Australia/Lord_Howe (30-minute fold on 2026-04-05 01:45;
    // occurs at 2026-04-04T14:45Z and 2026-04-04T15:15Z -> must pick earlier 14:45Z)
    const lordHoweFold = resolveScheduledInstant("2026-04-05", "01:45", "Australia/Lord_Howe");
    expect(lordHoweFold.toISOString()).toBe("2026-04-04T14:45:00.000Z");
  });
});
