import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerSignal } from '@farmslot/protocol';

import {
  isNoCodeTerminalDisposition,
  isTerminalWorkerSignal,
  normalizeWorkerSignal,
  parseStrictIsoMs,
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

test('parseStrictIsoMs accepts ISO-8601 shapes and rejects what bare Date.parse tolerates', () => {
  assert.equal(typeof parseStrictIsoMs('2026-05-05T01:08:16Z'), 'number');
  assert.equal(typeof parseStrictIsoMs('2026-05-05T01:08:16.123Z'), 'number');
  assert.equal(typeof parseStrictIsoMs('2026-05-05T03:08:16+02:00'), 'number');
  assert.equal(typeof parseStrictIsoMs('2026-05-05T01:08'), 'number');
  assert.equal(parseStrictIsoMs(undefined), null);
  assert.equal(parseStrictIsoMs(''), null);
  assert.equal(parseStrictIsoMs('not-a-date'), null);
  // Date.parse accepts these; the strict shape must not.
  assert.equal(parseStrictIsoMs('2026-04-25junk'), null);
  assert.equal(parseStrictIsoMs('2026-05-05'), null);
  assert.equal(parseStrictIsoMs(' 2026-05-05T01:08:16Z'), null);
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

test('normalizeWorkerSignal accepts a reviewer-scoped no-change report', () => {
  const result = normalizeWorkerSignal({
    status: 'complete',
    outcome: 'success',
    disposition: 'not_reproducible',
    evidence: {
      reportPath: 'artifacts/review-feedback.rev8-claude.md',
    },
    timestamp: '2026-05-05T01:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.signal.status, 'complete');
});

test('normalizeWorkerSignal rejects an unscoped reviewer no-change report', () => {
  const result = normalizeWorkerSignal({
    status: 'complete',
    outcome: 'success',
    disposition: 'not_reproducible',
    evidence: {
      reportPath: 'artifacts/review-feedback.md',
    },
    timestamp: '2026-05-05T01:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.signal.status, 'blocked');
  assert.match(result.ok ? (result.signal.reason ?? '') : '', /scoped/);
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
  assert.match(result.ok ? (result.signal.reason ?? '') : '', /review-feedback/);
});

test('normalizeWorkerSignal rejects non-no-change inconsistent tuples', () => {
  const result = normalizeWorkerSignal({
    status: 'failed',
    outcome: 'success',
    timestamp: '2026-05-05T01:00:00Z',
  });

  assert.equal(result.ok, false);
});
