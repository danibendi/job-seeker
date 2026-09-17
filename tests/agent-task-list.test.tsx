import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/actions', () => ({ controlAgentTask: vi.fn() }));
vi.mock('@/components/save-form', () => ({ SaveForm: ({ label }: { label?: string }) => label ?? 'Save' }));
import { AgentTaskList } from '@/components/agent-task-list';
import { stableJsonHash } from '@/lib/agent-task-contract';
import type { AgentTaskRecord } from '@/lib/agent-tasks';
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
  });
});
