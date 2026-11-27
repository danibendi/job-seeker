import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/actions', () => ({ controlAgentTask: vi.fn(), resumeWorker: vi.fn() }));
vi.mock('@/components/save-form', () => ({ SaveForm: ({ label, buttonAriaLabel }: { label?: string; buttonAriaLabel?: string }) => React.createElement('button', { 'aria-label': buttonAriaLabel }, label ?? 'Save') }));
import { AgentTaskList } from '@/components/agent-task-list';
import { AssistantStatusRow } from '@/components/assistant-status-row';
import { QaList } from '@/components/qa-list';
import { stableJsonHash } from '@/lib/agent-task-contract';
import type { AgentTaskRecord } from '@/lib/agent-tasks';
import { computeAssistantStatus } from '@/lib/assistant-status';
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('partial task UI temporary browser fixture', () => {
  it('renders v2 compact coverage counts', () => {
    const date = new Date('2026-09-14T10:00:00Z');
    const task = { id: '22222222-2222-4222-8222-222222222222', kind: 'search', executor: 'hermes', status: 'succeeded', attemptCount: 1, maxAttempts: 1, checkpoint: {}, result: { status: 'partial', summary: 'Durable gaps retained.', linkedin_coverage: { complete: false, fresh: { lanes: [{ touched_in_run: true }, { touched_in_run: false }], pending_detail_count: 2, backlog_pending_detail_count: 7 }, backfill: { lanes: [{ touched_in_run: false }], pending_detail_count: 5, backlog_pending_detail_count: 0 } } }, createdAt: date, updatedAt: date, availableAt: date, startedAt: date, completedAt: date, requestId: null, snapshotId: null, parentTaskId: null, resultHash: null, claimedBy: 'hermes-vps', leaseExpiresAt: null, scheduledFor: null, externalRef: null, lastError: null, dedupeKey: 'fixture', payload: {} } as AgentTaskRecord;
    const html = renderToStaticMarkup(<AgentTaskList tasks={[task]} timeZone="Europe/Prague" />);
    expect(html).toContain('Partial');
    expect(html).toContain('LinkedIn coverage is incomplete.');
    expect(html).toContain('Fresh: 1/2 lanes touched · 1 untouched · 2 details pending · 7 earlier pending');
    expect(html).toContain('Backfill: 0/1 lanes touched · 1 untouched · 5 details pending');
  });

  it('hides retry for a superseded task but keeps it for an ordinary cancellation', () => {
    const date = new Date('2026-09-15T15:04:53Z');
    const taskId = '686c3a29-586d-4722-a15f-6ff7a503dad5';
    const receipt = { taskId, session: { id: '7052e562-e0d0-4682-b623-a6dc4f52cb29', status: 'stopped' } };
    const base = { id: taskId, kind: 'search', executor: 'hermes', status: 'cancelled', attemptCount: 1, maxAttempts: 3,
      checkpoint: {}, result: null, createdAt: date, updatedAt: date, availableAt: date, startedAt: date, completedAt: date,
      requestId: null, snapshotId: null, parentTaskId: null, resultHash: null, claimedBy: null, leaseExpiresAt: null,
      scheduledFor: null, externalRef: null, lastError: 'Cancelled', dedupeKey: 'fixture-cancelled', payload: {} } as AgentTaskRecord;
    const ordinary = renderToStaticMarkup(<AgentTaskList tasks={[base]} timeZone="Europe/Prague" />);
    expect(ordinary).toContain('Retry');

    const recovery = { schemaVersion: 1, kind: 'linkedin_browser_receipt_recovery', action: 'supersede',
      planHash: 'a'.repeat(64), receiptHash: '', supersedeReason: 'Superseded by approved Prague-filtered discovery', receipt };
    recovery.receiptHash = stableJsonHash(receipt);
    const superseded = renderToStaticMarkup(<AgentTaskList tasks={[{
      ...base,
      checkpoint: { linkedinBrowserReceiptRecoveries: [recovery] },
    }]} timeZone="Europe/Prague" />);
    expect(superseded).not.toContain('Retry');

    const requestId = '7a7a7a7a-0000-4000-8000-000000000001';
    const dismissed = renderToStaticMarkup(<AgentTaskList tasks={[{ ...base, requestId }]} dismissedRequestIds={[requestId]} timeZone="Europe/Prague" />);
    expect(dismissed).toContain('Request dismissed');
    expect(dismissed).not.toContain('Retry');
  });

  it('shows a paused worker, its held task and why queued work waits', () => {
    const date = new Date('2026-11-24T08:20:00Z');
    const base = { kind: 'question', executor: 'codex', attemptCount: 1, maxAttempts: 3, result: null, createdAt: date, updatedAt: date,
      availableAt: date, startedAt: date, completedAt: null, requestId: null, snapshotId: null, parentTaskId: null, resultHash: null,
      claimedBy: null, leaseExpiresAt: null, scheduledFor: null, externalRef: null, lastError: null, payload: {} };
    const held = { ...base, id: '11111111-1111-4111-8111-111111111111', status: 'waiting_for_user', dedupeKey: 'held',
      checkpoint: { message: 'Codex stopped because the ChatGPT subscription usage limit was reached.',
        worker_run: { executor: 'codex', codex_cli_version: '0.171.0', model: 'gpt-6.2-sol', reasoning_effort: 'medium', elapsed_seconds: 2.4,
          usage: { input_tokens: 1200, output_tokens: 34 }, failure_category: 'usage_limit' } } } as AgentTaskRecord;
    const queued = { ...base, id: '22222222-1111-4111-8111-111111111111', status: 'queued', attemptCount: 0, dedupeKey: 'queued', checkpoint: {} } as AgentTaskRecord;
    const html = renderToStaticMarkup(<AgentTaskList tasks={[queued, held]} timeZone="Europe/London" workerPauses={[{
      workerId: 'worker-main', executor: 'codex', reason: 'usage_limit', taskId: held.id, pausedAt: date,
    }]} heldExecutors={['codex']} />);
    expect(html).toContain('Codex worker');
    expect(html).toContain('Subscription usage limit reached');
    expect(html).toContain('Resume worker');
    expect(html).toContain(`href="#task-${held.id}"`);
    expect(html).toContain('Waiting until the paused Codex worker is resumed.');
    expect(html).toContain('Codex 0.171.0 · gpt-6.2-sol · medium effort · 2 s · 1,234 tokens · stopped: Usage limit');
    expect(html).toContain('Queued tasks wait');

    // With another Codex worker still available, only the paused one stops.
    const shared = renderToStaticMarkup(<AgentTaskList tasks={[queued, held]} timeZone="Europe/London" workerPauses={[{
      workerId: 'worker-main', executor: 'codex', reason: 'usage_limit', taskId: held.id, pausedAt: date,
    }]} heldExecutors={[]} />);
    expect(shared).toContain('Other Codex workers keep working');
    expect(shared).not.toContain('Queued tasks wait');
    expect(shared).not.toContain('Waiting until the paused Codex worker is resumed.');
    expect(shared).toContain('worker-main');
    expect(shared).toContain('aria-label="Resume worker worker-main"');

    // A pause left for an executor with no registered worker does not promise that resuming helps.
    const unregistered = renderToStaticMarkup(<AgentTaskList tasks={[queued, held]} timeZone="Europe/London" workerPauses={[{
      workerId: 'worker-main', executor: 'codex', reason: 'usage_limit', taskId: held.id, pausedAt: date,
    }]} heldExecutors={[]} registeredExecutors={['api']} />);
    expect(unregistered).toContain('No Codex worker is registered');
    expect(unregistered).not.toContain('Waiting until the paused Codex worker is resumed.');

    // When an unpaused sibling exists but is offline, queued tasks note that either resuming
    // the paused worker or the sibling returning can unblock them.
    const offlineSibling = renderToStaticMarkup(<AgentTaskList tasks={[queued, held]} timeZone="Europe/London" workerPauses={[{
      workerId: 'worker-main', executor: 'codex', reason: 'usage_limit', taskId: held.id, pausedAt: date,
    }]} heldExecutors={['codex']} offlineSiblingExecutors={['codex']} />);
    expect(offlineSibling).toContain('Queued tasks wait');
    expect(offlineSibling).not.toContain('Other Codex workers keep working');
    expect(offlineSibling).toContain('Waiting until the paused Codex worker is resumed or another Codex worker comes back online.');
  });

  it('shows an interrupted task with expired lease and names the worker on queued tasks', () => {
    const date = new Date('2026-11-24T14:02:00Z');
    const interrupted = {
      id: '33333333-1111-4111-8111-111111111111', kind: 'question', executor: 'codex', status: 'running',
      attemptCount: 1, maxAttempts: 3, checkpoint: {}, result: null, createdAt: date, updatedAt: date,
      availableAt: date, startedAt: date, completedAt: null, requestId: null, snapshotId: null, parentTaskId: null,
      resultHash: null, claimedBy: 'codex-vps', leaseExpiresAt: new Date('2026-11-24T14:04:00Z'),
      scheduledFor: null, externalRef: null, lastError: null, dedupeKey: 'interrupted', payload: {},
    } as AgentTaskRecord;
    const queued = {
      ...interrupted, id: '44444444-1111-4111-8111-111111111111', status: 'queued', attemptCount: 0,
      claimedBy: null, leaseExpiresAt: null, dedupeKey: 'queued-codex',
    } as AgentTaskRecord;

    const html = renderToStaticMarkup(
      <AgentTaskList tasks={[interrupted, queued]} timeZone="Europe/London" interruptedTaskIds={[interrupted.id]} />,
    );
    expect(html).toContain('Interrupted');
    expect(html).toContain('The Codex worker stopped during this task. It runs again when the worker is back.');
    expect(html).not.toContain('Lease until');
    expect(html).toContain('Waiting for the Codex worker.');
  });

  it('renders AssistantStatusRow and QaList consistently across states', () => {
    const noneStatus = computeAssistantStatus({
      assistantLabel: 'Orbit',
      timeZone: 'Europe/London',
      now: new Date('2026-11-26T10:20:00Z'),
      chosenExecutors: [],
      registeredWorkers: [],
      workerContacts: [],
      workerPauses: [],
      runningTasks: [],
      waitingRequests: 2,
      lastSuccessfulSearchAt: null,
      schedule: { enabled: false, frequency: 'weekdays', time: '09:00', days: [], maxJobs: 15 },
      hasElapsedScheduleOccurrence: false,
    });
    expect(renderToStaticMarkup(<AssistantStatusRow status={noneStatus} href="/activity" variant="home" />)).toBe('');
    const activityNone = renderToStaticMarkup(<AssistantStatusRow status={noneStatus} variant="activity" />);
    expect(activityNone).toContain('No assistant connected');
    expect(activityNone).toContain('2 requests waiting');

    const offlineStatus = computeAssistantStatus({
      assistantLabel: 'Orbit',
      timeZone: 'Europe/London',
      now: new Date('2026-11-26T10:20:00Z'),
      chosenExecutors: ['codex'],
      registeredWorkers: [{ id: 'codex-1', executor: 'codex' }],
      workerContacts: [{ workerId: 'codex-1', executor: 'codex', lastSeenAt: new Date('2026-11-24T14:05:00Z') }],
      workerPauses: [],
      runningTasks: [],
      waitingRequests: 2,
      lastSuccessfulSearchAt: null,
      schedule: { enabled: false, frequency: 'weekdays', time: '09:00', days: [], maxJobs: 15 },
      hasElapsedScheduleOccurrence: false,
    });
    const homeOffline = renderToStaticMarkup(<AssistantStatusRow status={offlineStatus} href="/activity" variant="home" />);
    expect(homeOffline).toContain('Orbit is offline');
    expect(homeOffline).toContain('Last seen Tue 14:05 · 2 requests waiting');
    expect(homeOffline).toContain('href="/activity"');

    const qaOffline = renderToStaticMarkup(
      <QaList
        requests={[{
          id: 'req-1', text: 'Which of my CV variants fits this best?', status: 'in_progress',
          responseMd: null, errorMd: null, createdAt: new Date('2026-11-26T10:00:00Z'), answeredAt: null,
        }]}
        assistantStatus={offlineStatus}
        interruptedRequestIds={['req-1']}
      />,
    );
    expect(qaOffline).toContain('Waiting · Orbit is offline');
  });
});
