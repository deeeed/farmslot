import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { readGateAcceptance } = await import('./gate-prerequisites.js');
const { makeRun } = await import('./test-fixtures.js');

function nightlyRun(overrides: Partial<Run> = {}): Run {
  const base = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    lane: undefined,
    completionPolicy: 'artifact-only',
    taskFile: null,
    ticketData: {
      source: 'manual',
      title: 'Nightly device build',
      description: '',
      acceptanceCriteria: ['Nightly report line written'],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
    ...overrides,
  });
  return {
    ...base,
    scripted: { mode: 'command', commandRef: 'nightly-device-build' },
    metrics: { ...base.metrics, runner: 'scripted' },
  };
}

test('COMPLETE: a scripted command run with criteria and no ledger owes no acceptance verdicts', async () => {
  assert.deepEqual(await readGateAcceptance(nightlyRun()), {
    criteria: [],
    ledger: null,
    issues: [],
  });
});

test('the acceptance gate still applies to every other run', async () => {
  const worker = { ...nightlyRun(), metrics: { ...nightlyRun().metrics, runner: 'codex' } };
  const read = await readGateAcceptance(worker);
  assert.equal(
    read.error,
    'Task registration is missing',
    'the worker run is still read and refused',
  );
});
