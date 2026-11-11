import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import { WebSocket } from 'ws';

import type * as Support from '../node-support/ensure.js';

const root = await mkdtemp(path.join(tmpdir(), 'catalog-slot-'));
after(() => rm(root, { recursive: true, force: true }));
process.env = {
  PATH: process.env.PATH,
  TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH,
  HOME: root,
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
};
for (const dir of ['pool', 'projects/primary', 'projects/canary', 'services/gateway', 'scripts'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Synthetic farm\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
for (const project of ['primary', 'canary'])
  await writeFile(path.join(root, 'projects', project, 'project.json'), '{}');

async function pool(file: string, machine: string, project: string, slot?: string) {
  await writeFile(
    path.join(root, 'pool', file),
    JSON.stringify({
      machine,
      host: `${machine}.invalid`,
      ssh_user: 'fixture',
      os: 'linux',
      project,
      slots: slot ? [{ id: slot, repo: `/fixture/${slot}`, session: slot, resources: {} }] : [],
    }),
  );
}
await pool('canary-fixture-node.json', 'fixture-node', 'canary', 'canary-slot');
await pool('fixture-node.json', 'fixture-node', 'primary', 'regular-slot');
await pool('canary-only-node.json', 'only-node', 'canary', 'only-slot');
await pool('validation-only-node.json', 'only-node', 'canary', 'other-slot');
await pool('empty-node.json', 'empty-node', 'primary');
await pool('validation-empty-node.json', 'empty-node', 'canary', 'fallback-slot');

function gate() {
  let release: () => void = () => {
    throw new Error('gate not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
let activationStarted = gate();
let activation: Promise<void> = Promise.resolve();
let activationCalls = 0;
const ensure: typeof Support.ensureNodeSupportBundle = async (_vars, _runtime, options) => {
  activationCalls++;
  activationStarted.release();
  await activation;
  assert.ok(options?.collected);
  return {
    supportDir: `/fixture/support/${options.collected.manifest.hash}`,
    hash: options.collected.manifest.hash,
    paths: options.collected.manifest.paths,
    published: false,
  };
};
mock.module('../node-support/ensure.js', {
  namedExports: {
    ensureNodeSupportBundle: ensure,
    nodeSupportBundlePaths: () => ['scripts'],
    loadProjectVarsIfAny: async (name: string) =>
      (await import('../core/config.js')).loadProjectVars(name),
    collectNodeSupportBundle: async (): Promise<
      Awaited<ReturnType<typeof Support.collectNodeSupportBundle>>
    > => ({
      files: [],
      manifest: {
        version: 1,
        project: 'fixture',
        hash: 'a'.repeat(64),
        paths: ['scripts'],
        fileCount: 0,
        files: [],
      },
    }),
  },
});
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { handleNodeResponse } = await import('../fleet/node-rpc.js');
const calls: Array<{ command: string; timeout?: number }> = [];
let listingExitCode = 0;
for (const machine of ['fixture-node', 'only-node', 'empty-node']) {
  // Server-side socket with no network connection. ws requires its internal options argument.
  const socket: WebSocket = Reflect.construct(WebSocket, [null, undefined, { autoPong: true }]);
  Object.defineProperty(socket, 'readyState', { value: WebSocket.OPEN });
  mock.method(socket, 'send', (raw: string) => {
    const request = JSON.parse(raw);
    assert.equal(request.method, 'exec');
    calls.push({ command: request.params.cmd, timeout: request.params.timeout });
    queueMicrotask(() =>
      handleNodeResponse(
        request.id,
        true,
        {
          stdout: 'fixture/model',
          stderr: '',
          exitCode: listingExitCode,
        },
        undefined,
        undefined,
        socket,
      ),
    );
  });
  registerNode(machine, 1, socket);
  after(() => unregisterByWs(socket));
}

const { resetRemoteFarmCommandCache } = await import('../node-support/remote-command.js');
const { modelCatalogNodes } = await import('./runner-models.js');
const { getRunnerDefinition } = await import('../runners/registry.js');
const source = getRunnerDefinition('pi').modelCatalog;
assert.ok(source && 'nodeCommand' in source);

beforeEach(() => {
  resetRemoteFarmCommandCache();
  calls.length = 0;
  listingExitCode = 0;
  activationStarted = gate();
  activation = Promise.resolve();
  activationCalls = 0;
});

test('node catalogs prefer the canonical regular pool over a canary that sorts first', async () => {
  const nodes = await modelCatalogNodes();
  assert.equal(nodes.filter((node) => node.machine === 'fixture-node').length, 1);
  const node = nodes.find((node) => node.machine === 'fixture-node');
  assert.ok(node);
  await node.list(source);
  assert.match(calls[0].command, /\/fixture\/regular-slot/);
  assert.doesNotMatch(calls[0].command, /canary-slot/);
});

test('node catalogs fall back when the canonical pool is absent or has no slots', async () => {
  const nodes = await modelCatalogNodes();
  for (const [machine, slot] of [
    ['only-node', 'only-slot'],
    ['empty-node', 'fallback-slot'],
  ]) {
    const node = nodes.find((node) => node.machine === machine);
    assert.ok(node);
    await node.list(source);
    assert.ok(calls.at(-1)?.command.includes(`/fixture/${slot}`));
  }
});

test('slow support activation finishes before the node listing timeout starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = gate();
  activation = ready.promise;
  t.after(ready.release);
  const node = (await modelCatalogNodes()).find((node) => node.machine === 'fixture-node');
  assert.ok(node);
  const listing = node.list(source);
  // Attach the rejection handler before advancing timers, including on the unfixed path.
  const result = assert.doesNotReject(async () => assert.equal(await listing, 'fixture/model'));
  await activationStarted.promise;
  t.mock.timers.tick(20_001);
  assert.equal(calls.length, 0, 'listing waits for support readiness');
  ready.release();
  await result;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeout, 20_000, 'listing retains its full timeout');
  assert.match(calls[0].command, /\/fixture\/support\/[a-f0-9]{64}\/scripts\//);
  assert.doesNotMatch(calls[0].command, /~\/farmslot-node\/scripts\//);
  await node.list(source);
  assert.equal(activationCalls, 1, 'successful readiness is cached for the next listing');
});

test('node listings without a farm helper need no support activation', async () => {
  const plainSource = getRunnerDefinition('opencode').modelCatalog;
  assert.ok(plainSource && 'nodeCommand' in plainSource);
  const node = (await modelCatalogNodes()).find((node) => node.machine === 'fixture-node');
  assert.ok(node);
  assert.equal(await node.list(plainSource), 'fixture/model');
  assert.equal(activationCalls, 0);
  assert.equal(calls[0].timeout, 20_000);
});

test('a timed-out node listing still fails after support is ready', async () => {
  listingExitCode = 124;
  const node = (await modelCatalogNodes()).find((node) => node.machine === 'fixture-node');
  assert.ok(node);
  await assert.rejects(node.list(source), /exit code 124/);
  assert.equal(calls[0].timeout, 20_000);
});
