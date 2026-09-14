import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  isSlotViewContextPinUnresolved,
  isSlotViewTerminalRunStatus,
  selectSlotViewLinkedRun,
  shouldPreserveSlotViewCachedNullRun,
  slotViewLinkedRunTransition,
  slotViewNeedsDirectRunFetch,
} from './slot-view-linked-run-model.js';

function stubRun(id: string, slotId: string): Run {
  return {
    id,
    slotId,
    familyId: 'family-1',
    lane: 'default',
    flowType: 'dev',
    status: 'done',
    project: 'demo',
    mode: 'interactive',
    ticketOrPr: 'T-1',
    branch: 'main',
    summary: '',
    taskFile: '/tmp/TASK.md',
    steps: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metrics: {},
    decisions: [],
  } as unknown as Run;
}

test('selectSlotViewLinkedRun prefers fleet-bound run over stale URL pin', () => {
  const bound = stubRun('bound-run', 'mm-5');
  const stale = stubRun('stale-run', 'mm-5');
  assert.equal(
    selectSlotViewLinkedRun({
      requestedRunId: 'stale-run',
      slotBoundRunId: 'bound-run',
      cachedRun: stale,
      rpcRun: bound,
    })?.id,
    'bound-run',
  );
});

test('an explicit native context keeps its task history while a successor owns the slot', () => {
  const source = stubRun('source', 'slot');
  source.transport = 'native';
  source.agentContexts = [
    {
      id: 'dev',
      role: 'dev',
      label: 'Dev',
      runId: source.id,
      slotId: 'slot',
      target: null,
      status: 'failed',
      nativeSession: { sessionId: 'session', leaseId: 'old-lease', releasedAt: 'now' },
    },
  ] as unknown as Run['agentContexts'];
  const successor = stubRun('successor', 'slot');
  const selection = {
    requestedRunId: source.id,
    requestedContextId: 'dev',
    slotId: 'slot',
    slotBoundRunId: successor.id,
    cachedRun: source,
    rpcRun: successor,
  };
  assert.equal(selectSlotViewLinkedRun(selection), source);
  assert.equal(selectSlotViewLinkedRun({ ...selection, requestedContextId: 'missing' }), null);
  assert.equal(selectSlotViewLinkedRun({ ...selection, slotId: 'other-slot' }), null);
  assert.equal(selectSlotViewLinkedRun({ ...selection, cachedRun: null }), null);
  assert.equal(selectSlotViewLinkedRun({ ...selection, requestedContextId: undefined }), successor);
});

test('selectSlotViewLinkedRun keeps URL pin when slot is not bound elsewhere', () => {
  const pinned = stubRun('pinned-run', 'mm-5');
  const history = stubRun('history-run', 'mm-5');
  assert.equal(
    selectSlotViewLinkedRun({
      requestedRunId: 'pinned-run',
      slotBoundRunId: null,
      cachedRun: pinned,
      rpcRun: history,
    })?.id,
    'pinned-run',
  );
});

test('selectSlotViewLinkedRun avoids slot-history fallback while URL pin hydrates', () => {
  const history = stubRun('history-run', 'mm-5');
  assert.equal(
    selectSlotViewLinkedRun({
      requestedRunId: 'pinned-run',
      slotBoundRunId: null,
      cachedRun: null,
      rpcRun: history,
    }),
    null,
  );
});

test('isSlotViewTerminalRunStatus recognizes terminal run statuses only', () => {
  assert.equal(isSlotViewTerminalRunStatus('done'), true);
  assert.equal(isSlotViewTerminalRunStatus('failed'), true);
  assert.equal(isSlotViewTerminalRunStatus('cancelled'), true);
  assert.equal(isSlotViewTerminalRunStatus('monitoring'), false);
  assert.equal(isSlotViewTerminalRunStatus(null), false);
});

test('shouldPreserveSlotViewCachedNullRun keeps prior identity for cache hydration misses', () => {
  assert.equal(
    shouldPreserveSlotViewCachedNullRun({ source: 'cache', previousRunId: 'run-1' }),
    true,
  );
  assert.equal(
    shouldPreserveSlotViewCachedNullRun({ source: 'cache', previousRunId: null }),
    false,
  );
  assert.equal(
    shouldPreserveSlotViewCachedNullRun({ source: 'rpc', previousRunId: 'run-1' }),
    false,
  );
});

test('slotViewLinkedRunTransition clears contexts when run changes or reaches terminal', () => {
  assert.deepEqual(
    slotViewLinkedRunTransition({
      previousRunId: 'run-1',
      nextRunId: 'run-2',
      prevRunStatus: 'running',
      nextRunStatus: 'running',
    }),
    {
      reachedTerminal: false,
      runChanged: true,
      shouldClearAgentContext: true,
      shouldResetUnavailableContexts: true,
      shouldRefreshMonitoringProgress: false,
    },
  );

  assert.deepEqual(
    slotViewLinkedRunTransition({
      previousRunId: 'run-1',
      nextRunId: 'run-1',
      prevRunStatus: 'monitoring',
      nextRunStatus: 'done',
    }),
    {
      reachedTerminal: true,
      runChanged: false,
      shouldClearAgentContext: true,
      shouldResetUnavailableContexts: false,
      shouldRefreshMonitoringProgress: false,
    },
  );
});

test('slotViewLinkedRunTransition refreshes progress on monitoring entry only', () => {
  assert.equal(
    slotViewLinkedRunTransition({
      previousRunId: 'run-1',
      nextRunId: 'run-1',
      prevRunStatus: 'running',
      nextRunStatus: 'monitoring',
    }).shouldRefreshMonitoringProgress,
    true,
  );
  assert.equal(
    slotViewLinkedRunTransition({
      previousRunId: 'run-1',
      nextRunId: 'run-1',
      prevRunStatus: 'monitoring',
      nextRunStatus: 'monitoring',
    }).shouldRefreshMonitoringProgress,
    false,
  );
});

test('a pinned run is fetched directly when the cache has no row or only a trimmed run.list row', () => {
  const full = {
    id: 'r1',
    decisions: [{ id: 'd1', payload: { kind: 'ready' } }],
  } as unknown as Run;
  const trimmed = {
    id: 'r1',
    decisions: [{ id: 'd1', payload: { kind: 'ready' }, payloadTrimmed: ['prPackage'] }],
  } as unknown as Run;
  assert.equal(slotViewNeedsDirectRunFetch('r1', null), true);
  assert.equal(slotViewNeedsDirectRunFetch('r1', trimmed), true);
  assert.equal(slotViewNeedsDirectRunFetch('r1', full), false);
  assert.equal(slotViewNeedsDirectRunFetch(null, trimmed), false, 'no pin, no direct fetch');
  assert.equal(
    slotViewNeedsDirectRunFetch('r1', full, 'dev'),
    true,
    'context pin needs exact hydration',
  );
});

test('native publication rejects an unknown same-run pin during cache and direct hydration', () => {
  const run = stubRun('active', 'slot');
  run.transport = 'native';
  run.agentContexts = [
    {
      id: 'dev',
      role: 'dev',
      label: 'Dev',
      runId: run.id,
      slotId: 'slot',
      target: null,
      nativeSession: { sessionId: 'session', leaseId: 'lease' },
    },
  ] as unknown as Run['agentContexts'];
  const pin = { run, requestedRunId: run.id, requestedContextId: 'unknown', slotId: 'slot' };
  assert.equal(isSlotViewContextPinUnresolved(pin), true);
  assert.equal(isSlotViewContextPinUnresolved({ ...pin, run: null }), true);
  assert.equal(isSlotViewContextPinUnresolved({ ...pin, requestedContextId: 'dev' }), false);
  assert.equal(isSlotViewContextPinUnresolved({ ...pin, requestedContextId: null }), false);
  assert.equal(isSlotViewContextPinUnresolved({ ...pin, requestedRunId: null }), false);
  assert.equal(isSlotViewContextPinUnresolved({ ...pin, run: stubRun('bound', 'slot') }), false);
  assert.equal(
    shouldPreserveSlotViewCachedNullRun({
      source: 'cache',
      previousRunId: run.id,
      contextPinUnresolved: true,
    }),
    false,
    'a cached null must clear the prior conversation when its new pin is invalid',
  );
});
