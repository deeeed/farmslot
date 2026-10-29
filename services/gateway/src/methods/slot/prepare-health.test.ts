import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { SlotVars } from '../../core/config.js';

import type { runHealthCheck, runUnlockHook } from './check.js';

let read: typeof runHealthCheck = async () => '';
let unlock: typeof runUnlockHook = async () => null;
mock.module('./check.js', {
  namedExports: {
    runHealthCheck: (...args: Parameters<typeof runHealthCheck>) => read(...args),
    runUnlockHook: (...args: Parameters<typeof runUnlockHook>) => unlock(...args),
  },
});
const { verifyPrepareHealth, PREPARE_HEALTH_TIMEOUT_MS } = await import('./prepare-health.js');

const vars: SlotVars = {
  slotId: 'cold-health',
  machine: 'fixture',
  platform: 'web',
  host: 'localhost',
  sshUser: 'fixture',
  osType: 'darwin',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: '/fixture',
  session: 'cold-health',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: '',
  remoteRepo: '/fixture',
  projectName: 'fixture',
  resourceVars: {},
};
const commands = { health: 'health', unlock: '', parse: '', failedCommand: 'health' };

test('prepare waits for a cold server that becomes healthy three minutes later', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  let reads = 0;
  const budgets: number[] = [];
  read = async (_vars, _health, _parse, options) => {
    reads++;
    budgets.push(options?.timeoutMs ?? 0);
    return Date.now() >= 180_000 ? 'OK' : '';
  };
  const steps: string[] = [];
  let settled = false;
  const result = verifyPrepareHealth(vars, commands, 'OK', (_name, detail) =>
    steps.push(detail),
  ).finally(() => {
    settled = true;
  });
  await setImmediate();
  for (let elapsed = 0; elapsed < 178_000; elapsed += 2_000) {
    t.mock.timers.tick(2_000);
    await setImmediate();
  }
  assert.equal(settled, false, 'the first compile must not fail before it finishes');
  t.mock.timers.tick(2_000);
  assert.equal(await result, 'OK');
  assert.ok(reads > 1);
  assert.ok(budgets.every((budget) => budget > 0 && budget <= PREPARE_HEALTH_TIMEOUT_MS));
  assert.ok(steps.some((step) => step.includes('Waiting for health')));
  const previous = { reads, steps: steps.length };
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.deepEqual({ reads, steps: steps.length }, previous, 'no probe or heartbeat after success');
});

test('an unavailable server fails at the bounded deadline with its original failed command', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  read = async () => '';
  const result = verifyPrepareHealth(vars, commands, 'OK', () => {});
  const rejected = assert.rejects(result, {
    message: 'Health not ready (value=none, expected OK)',
    failedCommand: 'health',
  });
  await setImmediate();
  for (let elapsed = 0; elapsed < PREPARE_HEALTH_TIMEOUT_MS; elapsed += 2_000) {
    t.mock.timers.tick(2_000);
    await setImmediate();
  }
  await rejected;
});

test('unlock runs once and a failed unlock does not hide eventual observed readiness', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  let unlocks = 0;
  unlock = async () => {
    unlocks++;
    return 'unlock failed';
  };
  read = async () => (Date.now() >= 6_000 ? 'OK' : 'LOCKED');
  const steps: string[] = [];
  const result = verifyPrepareHealth(
    vars,
    { ...commands, unlock: 'unlock' },
    'OK',
    (_name, detail) => steps.push(detail),
  );
  await setImmediate();
  for (let elapsed = 0; elapsed < 6_000; elapsed += 2_000) {
    t.mock.timers.tick(2_000);
    await setImmediate();
  }
  assert.equal(await result, 'OK');
  assert.equal(unlocks, 1);
  assert.deepEqual(steps, ['Trying unlock...']);
});

test('a long first health request can finish the cold compile within the overall deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  read = async (_vars, _command, _parse, options) => {
    assert.ok((options?.timeoutMs ?? 0) >= 180_000, 'do not truncate the cold first request');
    await new Promise((resolve) => setTimeout(resolve, 180_000));
    return 'OK';
  };
  const result = verifyPrepareHealth(vars, commands, 'OK', () => {});
  t.mock.timers.tick(180_000);
  assert.equal(await result, 'OK');
});

test('cancelling prepare stops the health retry wait and its heartbeat', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  const controller = new AbortController();
  let reads = 0;
  let steps = 0;
  read = async () => {
    reads++;
    return '';
  };
  const result = verifyPrepareHealth(
    vars,
    commands,
    'OK',
    () => {
      steps++;
    },
    { signal: controller.signal },
  );
  const refused = assert.rejects(result, { name: 'AbortError' });
  await setImmediate();
  controller.abort();
  await refused;
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(reads, 1);
  assert.equal(steps, 0);
});
