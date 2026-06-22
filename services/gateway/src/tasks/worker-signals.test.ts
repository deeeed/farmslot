import assert from 'node:assert/strict';
import test from 'node:test';

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

test('done-partial worker signals normalize to blocked partial terminal signals', () => {
  const signal = terminalWorkerSignalFromRaw(
    JSON.stringify({
      status: 'done-partial',
      outcome: 'blocked-external-runtime-gap',
      reason: 'capture-helper screenshot failed',
      timestamp: '2026-06-22T09:47:23Z',
    }),
  );

  assert.equal(signal?.status, 'blocked');
  assert.equal(signal?.outcome, 'partial');
  assert.equal(signal?.disposition, 'blocked');
  assert.match(signal?.reason ?? '', /blocked-external-runtime-gap/);
  assert.match(signal?.reason ?? '', /capture-helper screenshot failed/);
  assert.equal(isTerminalWorkerSignal(signal!), true);
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

test('normalizeWorkerSignal accepts evidence-backed no-change terminal dispositions', () => {
  const result = normalizeWorkerSignal({
    status: 'complete',
    outcome: 'success',
    disposition: 'not_reproducible',
    evidence: {
      noCodeChange: true,
      reproductionAttempted: true,
      reportPath: '.task/proj-1/artifacts/no-change-report.md',
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

test('normalizeWorkerSignal converts insufficient no-change evidence to blocked partial', () => {
  const result = normalizeWorkerSignal({
    status: 'complete',
    outcome: 'success',
    disposition: 'not_reproducible',
    evidence: { noCodeChange: true },
    timestamp: '2026-05-05T01:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.signal.status, 'blocked');
  assert.equal(result.ok && result.signal.outcome, 'partial');
  assert.equal(result.ok && result.signal.disposition, 'blocked');
  assert.match(
    result.ok ? (result.signal.reason ?? '') : '',
    /reproductionAttempted|reportPath|artifacts/,
  );
});

test('normalizeWorkerSignal rejects non-no-change inconsistent tuples', () => {
  const result = normalizeWorkerSignal({
    status: 'failed',
    outcome: 'success',
    timestamp: '2026-05-05T01:00:00Z',
  });

  assert.equal(result.ok, false);
});
