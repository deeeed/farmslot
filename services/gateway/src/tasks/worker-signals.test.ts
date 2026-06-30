import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerSignal } from '@farmslot/protocol';

import {
  isNoCodeTerminalDisposition,
  isTerminalWorkerSignal,
  normalizeWorkerSignal,
  signalFreshAfterAll,
  signalFreshSince,
  terminalWorkerSignalFromRaw,
} from './worker-signals.js';

test('terminalWorkerSignalFromRaw parses only terminal worker signals', () => {
  assert.equal(
    isTerminalWorkerSignal({ status: 'complete', timestamp: '2026-05-05T01:00:00Z' }),
    true,
  );
  assert.equal(
    isTerminalWorkerSignal({ status: 'running', timestamp: '2026-05-05T01:00:00Z' }),
    false,
  );
  assert.deepEqual(
    terminalWorkerSignalFromRaw('{"status":"done","timestamp":"2026-05-05T01:00:00Z"}'),
    {
      status: 'done',
      timestamp: '2026-05-05T01:00:00Z',
    },
  );
  assert.equal(
    terminalWorkerSignalFromRaw('{"status":"running","timestamp":"2026-05-05T01:00:00Z"}'),
    undefined,
  );
});

test('normalizeWorkerSignal rejects unknown terminal statuses', () => {
  const result = normalizeWorkerSignal({
    status: 'done-partial',
    outcome: 'partial',
    reason: 'capture-helper screenshot failed',
    timestamp: '2026-06-22T09:47:23Z',
  } as unknown as WorkerSignal);

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /unknown status/);
});

test('signal freshness compares against durable context floors', () => {
  const signal = { status: 'complete' as const, timestamp: '2026-05-05T01:08:16Z' };

  assert.equal(signalFreshSince(signal, '2026-05-05T01:00:00Z'), true);
  assert.equal(signalFreshSince(signal, '2026-05-05T01:13:08Z'), false);
  assert.equal(signalFreshAfterAll(signal, ['2026-05-05T00:48:51Z', '2026-05-05T01:00:00Z']), true);
  assert.equal(
    signalFreshAfterAll(signal, ['2026-05-05T00:48:51Z', '2026-05-05T01:13:08Z']),
    false,
  );
});

test('normalizeWorkerSignal accepts report-backed no-change terminal dispositions', () => {
  const result = normalizeWorkerSignal({
    status: 'complete',
    outcome: 'success',
    disposition: 'not_reproducible',
    evidence: {
      reportPath: 'artifacts/no-change-report.md',
    },
    timestamp: '2026-05-05T01:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.signal.disposition, 'not_reproducible');
  assert.equal(
    isNoCodeTerminalDisposition(result.ok ? result.signal.disposition : undefined),
    true,
  );
});

test('normalizeWorkerSignal preserves optional checklist timing metadata', () => {
  const result = normalizeWorkerSignal({
    status: 'complete',
    outcome: 'success',
    checklistTiming: {
      schemaVersion: 1,
      source: 'CHECKLIST.md',
      events: [
        {
          stepNumber: 1,
          label: 'Run focused validation',
          checkedAt: '2026-06-25T10:00:00Z',
        },
      ],
    },
    timestamp: '2026-06-25T10:01:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.ok && result.signal.checklistTiming?.events[0]?.label,
    'Run focused validation',
  );
});

test('normalizeWorkerSignal converts missing no-change report path to blocked partial', () => {
  const result = normalizeWorkerSignal({
    status: 'complete',
    outcome: 'success',
    disposition: 'not_reproducible',
    timestamp: '2026-05-05T01:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.signal.status, 'blocked');
  assert.equal(result.ok && result.signal.outcome, 'partial');
  assert.equal(result.ok && result.signal.disposition, 'blocked');
  assert.match(result.ok ? (result.signal.reason ?? '') : '', /reportPath/);
});

test('normalizeWorkerSignal rejects non-canonical no-change report paths', () => {
  const result = normalizeWorkerSignal({
    status: 'complete',
    outcome: 'success',
    disposition: 'not_reproducible',
    evidence: { reportPath: 'artifacts/other-report.md' },
    timestamp: '2026-05-05T01:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.signal.status, 'blocked');
  assert.match(result.ok ? (result.signal.reason ?? '') : '', /artifacts\/no-change-report\.md/);
});

test('normalizeWorkerSignal rejects non-no-change inconsistent tuples', () => {
  const result = normalizeWorkerSignal({
    status: 'failed',
    outcome: 'success',
    timestamp: '2026-05-05T01:00:00Z',
  });

  assert.equal(result.ok, false);
});
