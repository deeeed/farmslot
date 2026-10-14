import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { WebSocketServer } from 'ws';

import type { RecipeArtifactManifestEntry } from '@farmslot/protocol';

import { createStandardUiAdapters } from '../src/adapters/ui.js';
import { isRecord } from '../src/core/json.js';
import type { ActionExecutionContext } from '../src/core/types.js';
import { captureHelperSnapshot } from '../src/recording/capture-helper.js';
import { CdpSession, CdpWebPage, createCdpWebUiTransport } from '../src/runtime/cdp.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ui-window-screenshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registered: RecipeArtifactManifestEntry[] = [];
  const context: ActionExecutionContext = {
    nodeId: 'window-shot',
    recipe: {},
    projectRoot: root,
    artifactsDir: root,
    env: {},
    outputs: new Map(),
    getOutput: () => undefined,
    resolveProjectPath: (relative) => path.join(root, relative),
    resolveArtifactPath: (relative) => path.join(root, relative),
    getRunFileOffset: () => undefined,
    registerArtifact: (entry) => {
      registered.push(entry);
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { root, context, registered };
}

async function cdpPage(t: TestContext) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const client of server.clients) client.terminate();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  server.on('connection', (socket) =>
    socket.on('message', (data) => {
      const request: unknown = JSON.parse(data.toString());
      assert.ok(isRecord(request) && typeof request.id === 'number');
      assert.ok(
        ['Page.captureScreenshot', 'Page.getLayoutMetrics'].includes(String(request.method)),
      );
      socket.send(
        JSON.stringify({
          id: request.id,
          result:
            request.method === 'Page.captureScreenshot'
              ? { data: png.toString('base64') }
              : { cssContentSize: { width: 1, height: 1 } },
        }),
      );
    }),
  );
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const session = await CdpSession.connect(`ws://127.0.0.1:${address.port}`);
  t.after(() => session.close());
  return new CdpWebPage(session);
}

test('native screenshot publishes through the rooted writer without opening CDP', async (t) => {
  const f = await fixture(t);
  const transport = createCdpWebUiTransport({
    screenshotProvider: {
      name: 'capture-helper',
      capture: async () => ({ data: png, metadata: { selected: { pid: 42 } } }),
    },
    getPage: async () => assert.fail('native capture must not open a CDP page'),
  });
  await transport.execute(
    'ui.screenshot',
    { path: 'shots/panel.png', label: 'App and panel' },
    f.context,
  );
  assert.deepEqual(await readFile(path.join(f.root, 'shots/panel.png')), png);
  assert.equal(f.registered.length, 1);
  assert.equal(f.registered[0].label, 'App and panel');
  assert.equal(f.registered[0].metadata?.captureProvider, 'capture-helper');
  assert.deepEqual(f.registered[0].metadata?.selected, { pid: 42 });
});

test('native refusal falls back to CDP and preserves the provider refusal in evidence', async (t) => {
  const f = await fixture(t);
  const page = await cdpPage(t);
  const transport = createCdpWebUiTransport({
    screenshotProvider: {
      name: 'capture-helper',
      capture: async () => {
        throw new Error('capture_busy');
      },
    },
    getPage: async () => page,
  });
  await transport.execute('ui.screenshot', { path: 'fallback.png' }, f.context);
  assert.deepEqual(await readFile(path.join(f.root, 'fallback.png')), png);
  assert.deepEqual(f.registered[0].metadata, {
    captureProvider: 'cdp',
    fallbackFrom: 'capture-helper',
    fallbackReason: 'capture_busy',
  });
});

test('full-surface capture bypasses the native screenshot provider', async (t) => {
  const f = await fixture(t);
  const transport = createCdpWebUiTransport({
    screenshotProvider: {
      name: 'capture-helper',
      capture: async () => assert.fail('full surface uses CDP'),
    },
    getPage: () => cdpPage(t),
  });
  await transport.execute('ui.capture_surface', { path: 'full.png' }, f.context);
  assert.deepEqual(await readFile(path.join(f.root, 'full.png')), png);
  await transport.execute('ui.screenshot', { path: 'full-page.png', fullPage: true }, f.context);
  assert.deepEqual(await readFile(path.join(f.root, 'full-page.png')), png);
});

test('recorded UI screenshots keep their session snapshot and avoid a standalone capture', async (t) => {
  const f = await fixture(t);
  f.context.captureRecordingSnapshot = async () => ({ output: 'recorded.png', segmentIndex: 2 });
  const transport = createCdpWebUiTransport({
    screenshotProvider: {
      name: 'capture-helper',
      capture: async () => assert.fail('recording owns this snapshot'),
    },
    getPage: async () => assert.fail('recording owns this snapshot'),
  });
  const adapter = createStandardUiAdapters({ transport, actions: ['ui.screenshot'] })[0];
  const result = await adapter.execute({ path: 'recorded.png' }, f.context);
  assert.equal(result.artifacts?.[0].path, 'recorded.png');
  assert.ok(isRecord(result.output));
  assert.equal(result.output.segmentIndex, 2);
});

test('native capture cannot publish outside the artifact root or through a symlink', async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'screenshot-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(f.root, 'escape'));
  const transport = createCdpWebUiTransport({
    screenshotProvider: { name: 'capture-helper', capture: async () => ({ data: png }) },
    getPage: async () => assert.fail('artifact path refusal is not a provider fallback'),
  });
  for (const shotPath of ['../outside.png', 'escape/outside.png'])
    await assert.rejects(transport.execute('ui.screenshot', { path: shotPath }, f.context));
  assert.equal(f.registered.length, 0);
  await assert.rejects(readFile(path.join(outside, 'outside.png')), { code: 'ENOENT' });
});

test('an interrupted native screenshot is not published or retried with CDP', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.context.signal = controller.signal;
  const transport = createCdpWebUiTransport({
    screenshotProvider: {
      name: 'capture-helper',
      capture: async () => {
        controller.abort(new Error('Operator cancelled'));
        return { data: png };
      },
    },
    getPage: async () => assert.fail('cancellation is not a provider fallback'),
  });
  await assert.rejects(transport.execute('ui.screenshot', {}, f.context), /Operator cancelled/);
  assert.equal(f.registered.length, 0);
});

test('capture-helper snapshots preserve target identity and clean their private staging files', async (t) => {
  const f = await fixture(t);
  const helper = path.join(f.root, 'helper.cjs');
  await writeFile(
    helper,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]!=='snapshot'||args[1]!=='--pid'||args[2]!=='42')process.exit(2);
const output=args[args.indexOf('--output')+1];fs.writeFileSync(output,Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));
console.log(JSON.stringify({type:'snapshot',output,selected:{pid:42}}));
`,
    { mode: 0o755 },
  );
  const capture = await captureHelperSnapshot(
    { kind: 'pid', pid: 42 },
    { captureHelperPath: helper },
  );
  assert.deepEqual(capture.data, png);
  assert.deepEqual(capture.metadata.selected, { pid: 42 });
  assert.ok(typeof capture.metadata.output === 'string');
  await assert.rejects(readFile(capture.metadata.output), { code: 'ENOENT' });
});
