// F331: recovery asks the runner's own evidence whether an interrupted DISPATCH's prompt arrived.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

const SENT_AT = '2026-11-02T14:03:52.000Z';
let accepted = true;
const probes: unknown[][] = [];
const signalReads: string[] = [];

const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => makeVars({ slotId: 'slot-1', projectName: 'demo' }),
  },
});
const prompts = await import('../runners/worker-prompt.js');
mock.module('../runners/worker-prompt.js', {
  namedExports: {
    ...prompts,
    resolveWorkerDispatchPrompt: async (project: string, vars: { taskFile: string }) =>
      `${project}: read ${vars.taskFile}`,
  },
});
const evidence = await import('../runners/prompt-delivery-evidence.js');
mock.module('../runners/prompt-delivery-evidence.js', {
  namedExports: {
    ...evidence,
    readLaunchAckSignalSnapshot: async (_vars: unknown, signalPath: string) => {
      signalReads.push(signalPath);
      return { raw: null, status: null, mtimeNs: '0' };
    },
  },
});
const registry = await import('../runners/registry.js');
mock.module('../runners/registry.js', {
  namedExports: {
    ...registry,
    runnerHasDurablePromptHandoff: async (...args: unknown[]) => {
      probes.push(args);
      return { accepted, reason: 'fixture' };
    },
  },
});
const { dispatchPromptHandoffProven } = await import('./runtime-recovery.js');

const worker: AgentContext = {
  id: 'fix-bug',
  role: 'fix-bug',
  label: 'Worker',
  status: 'working',
  slotId: 'slot-1',
  runId: 'run-f331',
  runner: 'claude',
  promptDeliveryStartedAt: SENT_AT,
  taskFile: 'tasks/fix/TASK.md',
  signalFile: 'tasks/fix/SIGNAL.json',
  target: { session: 'slot-1', window: 'worker', pane: null, target: 'slot-1:worker' },
};
const run = makeRun({ id: 'run-f331', flowType: 'fix-bug', slotId: 'slot-1' });

test('the probe matches the exact prompt from the attempt stamp and accepts the task signal', async () => {
  accepted = true;
  assert.equal(await dispatchPromptHandoffProven(run, worker), true);
  assert.equal(probes.length, 1);
  const [, target, runner, prompt, sinceMs, options] = probes[0]!;
  assert.equal(target, 'slot-1:worker');
  assert.equal(runner, 'claude');
  assert.equal(prompt, 'demo: read tasks/fix/TASK.md');
  assert.equal(sinceMs, Date.parse(SENT_AT));
  assert.deepEqual(options, {
    launchAckSignalPath: 'tasks/fix/SIGNAL.json',
    launchAckBaseline: { raw: null, status: null, mtimeNs: '0' },
    acceptExistingLaunchAck: true,
    requirePromptDigest: true,
  });
  assert.deepEqual(signalReads, ['tasks/fix/SIGNAL.json']);
});

test('no evidence, and a worker with nothing to probe, is not proof', async () => {
  accepted = false;
  assert.equal(await dispatchPromptHandoffProven(run, worker), false);
  const before = probes.length;
  assert.equal(await dispatchPromptHandoffProven(run, { ...worker, target: undefined }), false);
  assert.equal(await dispatchPromptHandoffProven(run, { ...worker, taskFile: undefined }), false);
  assert.equal(probes.length, before);
});
