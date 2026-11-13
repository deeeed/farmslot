import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  BackgroundRequestError,
  BackgroundTimeoutError,
  BackgroundUnavailableError,
  ForkedBackgroundHost,
} from './client.js';

// A plain-node stand-in for child.ts: it speaks the same IPC protocol, and FIXTURE_MODE picks
// how it answers. Forking it costs milliseconds; the real child is covered by child.smoke.
const directory = await mkdtemp(path.join(os.tmpdir(), 'background-client-'));
after(() => rm(directory, { recursive: true, force: true }));
const entry = path.join(directory, 'fixture-child.mjs');
await writeFile(
  entry,
  `
const mode = process.env.FIXTURE_MODE;
const post = (message) => process.send(message);
process.on('disconnect', () => process.exit(0));
process.on('message', (message) => {
  if (message.type === 'shutdown') {
    if (mode === 'ignore-shutdown') return;
    process.exit(0);
  }
  if (message.type === 'cancel') return;
  const base = { type: 'result', id: message.id, operation: message.operation, rssBytes: 1_048_576 };
  if (mode === 'hang') return;
  if (mode === 'crash') process.exit(3);
  if (mode === 'fail')
    return post({ ...base, ok: false, error: { name: 'Error', message: 'probe broke' }, exec: {} });
  post({ ...base, ok: true, value: message.params, exec: { shell: { calls: 2, seconds: 0.5 } } });
});
const ready = () => post({ type: 'ready', pid: process.pid, rssBytes: 1_048_576, activeResources: [] });
if (mode === 'slow-ready') setTimeout(ready, 300);
else if (mode !== 'never-ready') ready();
`,
);

function host(
  mode: string,
  overrides: { shutdownGraceMs?: number; startupBudgetMs?: number } = {},
): ForkedBackgroundHost {
  const instance = new ForkedBackgroundHost({
    entry,
    execArgv: [],
    env: { ...process.env, FIXTURE_MODE: mode, FARMSLOT_GATEWAY_BACKGROUND: '1' },
    restartDelaysMs: [20, 40],
    shutdownGraceMs: overrides.shutdownGraceMs ?? 2_000,
    ...(overrides.startupBudgetMs ? { startupBudgetMs: overrides.startupBudgetMs } : {}),
  });
  after(() => instance.stop());
  return instance;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const scan = { deadlineMs: 5_000 };

test('a request returns the child result and accumulates its exec tally', async () => {
  const background = host('echo');
  background.start();
  assert.equal(background.active(), true);
  assert.deepEqual(await background.request('decisions.scan', {}, scan), {});
  await background.request('decisions.scan', {}, scan);
  const status = background.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.rssBytes, 1_048_576);
  assert.deepEqual(status.exec['decisions.scan'], { shell: { calls: 4, seconds: 1 } });
});

test('an operation that fails in the child rejects with its message', async () => {
  const background = host('fail');
  background.start();
  await assert.rejects(background.request('decisions.scan', {}, scan), (error: unknown) => {
    assert.ok(error instanceof BackgroundRequestError);
    assert.equal(error.message, 'probe broke');
    return true;
  });
  assert.equal(background.status().failures['decisions.scan']?.message, 'probe broke');
});

test('two missed deadlines kill a wedged child, which restarts', async () => {
  const background = host('hang');
  background.start();
  await until(() => background.status().state === 'ready', 'first ready');
  const pid = background.status().pid;
  for (let miss = 0; miss < 2; miss++)
    await assert.rejects(
      background.request('decisions.scan', {}, { deadlineMs: 50 }),
      BackgroundTimeoutError,
    );
  await until(() => background.status().restarts === 1, 'the wedge restart');
  assert.equal(background.status().lastExit?.signal, 'SIGKILL');
  await until(() => background.status().state === 'ready', 'ready after restart');
  assert.notEqual(background.status().pid, pid);
});

test('a slow start is not a missed deadline and never restarts the child', async () => {
  const slow = host('slow-ready');
  slow.start();
  // The answer deadline starts once the request is sent, after the child is ready.
  assert.deepEqual(await slow.request('decisions.scan', {}, { deadlineMs: 100 }), {});

  const stuck = host('never-ready', { startupBudgetMs: 100 });
  stuck.start();
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      stuck.request('decisions.scan', {}, { deadlineMs: 50 }),
      /did not become ready within 100 ms/,
    );
  assert.equal(stuck.status().restarts, 0);
  assert.equal(stuck.status().state, 'starting');
});

test('a crash rejects pending work, refuses requests while down, then recovers', async () => {
  const background = host('crash');
  background.start();
  await assert.rejects(background.request('decisions.scan', {}, scan), (error: unknown) => {
    assert.ok(error instanceof BackgroundUnavailableError);
    assert.match(error.message, /exited \(code 3/);
    return true;
  });
  assert.equal(background.status().state, 'restarting');
  await assert.rejects(
    background.request('decisions.scan', {}, scan),
    /background process is restarting after exit \(code 3/,
  );
  await until(() => background.status().state === 'ready', 'ready after the crash');
  assert.equal(background.status().restarts, 1);
});

test('stop asks the child to exit and kills one that ignores it', async () => {
  const clean = host('echo');
  clean.start();
  await until(() => clean.status().state === 'ready', 'ready');
  await clean.stop();
  assert.equal(clean.status().state, 'stopped');
  assert.equal(clean.status().lastExit?.code, 0);
  assert.equal(clean.active(), false);

  const stubborn = host('ignore-shutdown', { shutdownGraceMs: 50 });
  stubborn.start();
  await until(() => stubborn.status().state === 'ready', 'ready');
  await stubborn.stop();
  assert.equal(stubborn.status().lastExit?.signal, 'SIGKILL');
  assert.equal(stubborn.status().state, 'stopped');
});

test('FARMSLOT_GATEWAY_BACKGROUND=0 keeps every operation in-process', () => {
  const disabled = new ForkedBackgroundHost({
    entry,
    env: { ...process.env, FARMSLOT_GATEWAY_BACKGROUND: '0' },
  });
  disabled.start();
  assert.equal(disabled.active(), false);
  assert.equal(disabled.status().state, 'disabled');
});
