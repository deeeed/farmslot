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

test('COMPLETE: run 935c72fd as frozen (worker contract, CHECKLIST.md, no receipt) owes no CI receipt', async (t) => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { validateDeterministicChecksForRun } =
    await import('../tasks/worker-terminal-contract.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-scripted-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'inputs'), { recursive: true });
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(path.join(root, 'TASK.md'), '# Task\n');
  writeFileSync(
    path.join(root, 'CHECKLIST.md'),
    '# Worker\n- [ ] 12. Changed-file CI [DETERMINISTIC: ci.local_check]. Call `<task>/mark 12`.\n',
  );
  writeFileSync(
    path.join(root, 'inputs', 'worker-terminal-contract.json'),
    JSON.stringify({
      schemaVersion: 1,
      flowType: 'dev',
      requireSignal: true,
      acceptance: { require: true },
      commands: {
        complete: { artifacts: [] },
        'no-change': { artifacts: [] },
        blocked: { artifacts: [] },
      },
      whenPresent: [],
      resolvedAt: '2026-11-09T03:01:16.000Z',
      source: 'project',
      deterministicChecks: [
        {
          checklist: 'CHECKLIST.md',
          stepNumber: 12,
          reference: 'ci.local_check',
          command: 'bash temp/farmslot/ci-parity',
        },
      ],
    }),
  );
  const frozen = nightlyRun({ taskFile: path.join(root, 'TASK.md'), slotId: null });
  assert.deepEqual(await validateDeterministicChecksForRun(frozen), []);
  // The same task for a worker run still owes its receipt.
  const worker = { ...frozen, metrics: { ...frozen.metrics, runner: 'codex' } };
  await assert.rejects(validateDeterministicChecksForRun(worker));
});
