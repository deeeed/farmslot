import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createWebDappAdapter, ownerMarker, webDappRuntimeDir } from '../src/web-dapp/index.mjs';

import { policy } from './fixtures/web-dapp-policy.mjs';

const savedPolicy = process.env.RECIPE_WEB_DAPP_POLICY;
process.env.RECIPE_WEB_DAPP_POLICY = policy.module;
after(() => {
  if (savedPolicy === undefined) delete process.env.RECIPE_WEB_DAPP_POLICY;
  else process.env.RECIPE_WEB_DAPP_POLICY = savedPolicy;
});

async function fixture(t, owner = 'same') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-recording-'));
  const runtime = webDappRuntimeDir(root);
  mkdirSync(runtime, { recursive: true });
  const marker = ownerMarker('browser', owner === 'same' ? runtime : `${runtime}-neighbour`);
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      const server = require('net').createServer();
      server.listen(0, '127.0.0.1', () => process.send(server.address().port));
      process.on('disconnect', () => process.exit());
    `,
      '--',
      ...(owner === 'foreign' ? [] : [marker]),
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const [port] = await once(child, 'message', { signal: AbortSignal.timeout(2000) });
  const state = { browserPid: child.pid, cdpPort: port };
  const save = (value = state) =>
    writeFileSync(path.join(runtime, 'browser.json'), JSON.stringify(value));
  save();
  const context = { projectRoot: root, env: { RECIPE_CDP_PORT: String(port) }, node: {} };
  const recording = createWebDappAdapter().recording;
  assert.ok(recording);
  return { root, child, context, recording, save, state };
}

test('selects the owned listener through the public adapter, including a symlinked checkout', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.recording.target(f.context), { kind: 'pid', pid: f.child.pid });
  const link = path.join(f.root, 'checkout-link');
  symlinkSync(f.root, link);
  assert.deepEqual(await f.recording.target({ ...f.context, projectRoot: link }), {
    kind: 'pid',
    pid: f.child.pid,
  });
});

for (const owner of ['foreign', 'neighbour']) {
  test(`refuses a ${owner} listener without signalling it`, async (t) => {
    const f = await fixture(t, owner);
    await assert.rejects(f.recording.target(f.context), /Could not resolve the owned/);
    assert.doesNotThrow(() => process.kill(f.child.pid, 0));
  });
}

test('refuses missing, stale and mismatched browser state and a different selected port', async (t) => {
  const f = await fixture(t);
  for (const state of [null, { ...f.state, browserPid: 0 }, { ...f.state, cdpPort: 0 }]) {
    f.save(state);
    await assert.rejects(f.recording.target(f.context), /Could not resolve the owned/);
  }
  f.save();
  const otherPort = f.state.cdpPort === 65535 ? 65534 : f.state.cdpPort + 1;
  await assert.rejects(
    f.recording.target({ ...f.context, env: { RECIPE_CDP_PORT: String(otherPort) } }),
    /Could not resolve the owned/,
  );
  // A valid owner marker alone cannot prove that this process owns the recorded listener.
  f.save({ ...f.state, cdpPort: otherPort });
  await assert.rejects(
    f.recording.target({ ...f.context, env: { RECIPE_CDP_PORT: String(otherPort) } }),
    /Could not resolve the owned/,
  );
  f.save();
  const exited = once(f.child, 'exit');
  f.child.kill();
  await exited;
  await assert.rejects(f.recording.target(f.context), /Could not resolve the owned/);
});
