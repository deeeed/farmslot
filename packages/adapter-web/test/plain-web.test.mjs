import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  createPlainWebAdapter,
  plainWebRuntimeDir,
  stopPlainWebBrowser,
} from '../src/plain-web.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-web-'));
const originalPort = process.env.RECIPE_CDP_PORT;
after(() => {
  if (originalPort === undefined) delete process.env.RECIPE_CDP_PORT;
  else process.env.RECIPE_CDP_PORT = originalPort;
  fs.rmSync(root, { recursive: true, force: true });
});
const adapter = createPlainWebAdapter({
  manifestPath: '/project/actions.json',
  url: () => 'http://127.0.0.1:9315/',
  serverLabel: 'Website',
});

test('the public runtime retains shared UI and recording support without another server owner', () => {
  assert.equal(adapter.id, 'web');
  assert.equal(adapter.headless, false);
  assert.equal(adapter.actions.manifestPath(), '/project/actions.json');
  assert.equal(adapter.harness.kind, 'built-in');
  assert.equal(typeof adapter.actions.ui, 'function');
  assert.equal(typeof adapter.recording.target, 'function');
  assert.equal(plainWebRuntimeDir(root), path.join(fs.realpathSync(root), '.agent/web'));
});

test('missing assigned browser ports block readiness and recording instead of selecting an ambient browser', async () => {
  process.env.RECIPE_CDP_PORT = '0';
  const status = await adapter.runtimeStatus(root);
  assert.equal(status.decision, 'blocked');
  assert.match(status.reasons.join(' '), /assigned --cdp-port/);
  await assert.rejects(
    adapter.recording.target({ projectRoot: root, env: {}, node: {} }),
    /assigned --cdp-port/,
  );
});

test('recording uses its execution port instead of the ambient process port', async () => {
  process.env.RECIPE_CDP_PORT = '9316';
  await assert.rejects(
    adapter.recording.target({ projectRoot: root, env: { RECIPE_CDP_PORT: '0' }, node: {} }),
    /assigned --cdp-port/,
  );
});

test('built-in verification reports blocked readiness instead of claiming a prepared browser', async () => {
  process.env.RECIPE_CDP_PORT = '0';
  const verification = adapter.harness.verify(root);
  assert.ok('inProcess' in verification);
  const verify = await verification.inProcess();
  const messages = [];
  const code = await verify([], {
    out: (line) => messages.push(line),
    err: (line) => messages.push(line),
  });
  assert.equal(code, 1);
  assert.match(messages.join(' '), /assigned --cdp-port/);
});

test('browser stop is idempotent without ambient CDP port options', () => {
  process.env.RECIPE_CDP_PORT = '0';
  assert.deepEqual(stopPlainWebBrowser(root), { stopped: true });
  assert.deepEqual(stopPlainWebBrowser(root), { stopped: true });
});
