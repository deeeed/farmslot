import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { WebSocket } from 'ws';

import { Methods } from '@farmslot/protocol';

// Config paths are captured at import. Keep all enrollment and pool fixtures private.
const root = await mkdtemp(path.join(os.tmpdir(), 'native-local-node-catalog-'));
after(() => rm(root, { recursive: true, force: true }));
for (const dir of ['scripts', 'services/gateway'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Test root\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.FARMSLOT_NATIVE_STATE_DIR = path.join(root, 'native');

const { createGatewayAuthRuntime } = await import('../security/auth.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { handleNodeResponse } = await import('../fleet/node-rpc.js');
const { nodeModelCatalogs } = await import('../runners/model-catalog.js');
const { nativeCatalog, nativeModelNodeBlocker } = await import('./native-workspace.js');
const { nativeSessionRoute } = await import('./native-session.js');

const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const admin = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
const farm = runtime.writer.createPrincipal({ type: 'service', displayName: 'Farm' }, admin);
runtime.writer.issueCredential(farm.id, 'Fixture admin');
const person = runtime.writer.createPrincipal({ type: 'person', displayName: 'Person' }, admin);
const other = runtime.writer.createPrincipal({ type: 'person', displayName: 'Other' }, []);
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = farm.id;
await mkdir(process.env.FARMSLOT_POOL_DIR, { recursive: true });
for (const [machine, owner, host] of [
  ['macwork', person.id, 'localhost'],
  ['macpro', farm.id, 'macpro.invalid'],
] as const) {
  runtime.writer.createPrincipal(
    { type: 'node', displayName: machine, machine, nativeOwnerPrincipalId: owner },
    [],
    `node-${machine}`,
  );
  await writeFile(
    path.join(process.env.FARMSLOT_POOL_DIR, `${machine}.json`),
    JSON.stringify({
      machine,
      host,
      project: 'fixture',
      ssh_user: 'fixture',
      os: 'macos',
      slots: [{ id: `${machine}-fixture`, repo: path.join(root, machine), session: machine }],
    }),
  );
}

test('a same-host node owner can select its issued machine from the catalog and create there', async () => {
  let valid = true;
  let requests = 0;
  const session = {
    requestedByPrincipalId: person.id,
    requestedByPrincipalGeneration: 0,
    id: 'catalog-session',
    ownerPrincipalId: person.id,
    executionNodeId: 'macwork',
  };
  const socket = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const frame = JSON.parse(raw);
      requests++;
      assert.equal(frame.method, 'native.session');
      assert.equal(frame.params.owner, person.id);
      assert.equal(frame.params.method, Methods.NATIVE_SESSION_CREATE);
      assert.equal(frame.params.params.executionNodeId, 'macwork');
      assert.equal(frame.params.params.cwd, path.join(root, 'macwork'));
      handleNodeResponse(frame.id, true, { session }, undefined, undefined, socket);
    },
  } as WebSocket;
  const remote = { readyState: WebSocket.OPEN } as WebSocket;
  registerNode(
    'macwork',
    1,
    socket,
    undefined,
    undefined,
    {
      ownerPrincipalId: person.id,
      supportsEnsure: true,
      supportsProfiles: true,
      supportsStandaloneDelegation: true,
    },
    { principalId: 'node-macwork', valid: () => valid },
  );
  registerNode(
    'macpro',
    1,
    remote,
    undefined,
    undefined,
    { ownerPrincipalId: farm.id },
    { principalId: 'node-macpro', valid: () => true },
  );
  try {
    const catalog = await nativeCatalog(person.id);
    assert.deepEqual(catalog.contexts, [
      {
        executionNodeId: 'macwork',
        cwd: path.join(root, 'macwork'),
        label: 'macwork-fixture',
        slotId: 'macwork-fixture',
        project: 'fixture',
        supportsProfiles: true,
      },
    ]);
    const context = catalog.contexts[0]!;
    assert.deepEqual(
      await runWithSessionOriginator(person, () =>
        nativeSessionRoute(
          Methods.NATIVE_SESSION_CREATE,
          { executionNodeId: context.executionNodeId, cwd: context.cwd, runner: 'codex' },
          person,
        ),
      ),
      { session },
    );
    assert.equal(requests, 1);
    assert.deepEqual((await nativeCatalog(other.id)).contexts, []);
    await assert.rejects(
      runWithSessionOriginator(other, () =>
        nativeSessionRoute(
          Methods.NATIVE_SESSION_CREATE,
          { executionNodeId: context.executionNodeId, cwd: context.cwd, runner: 'codex' },
          other,
        ),
      ),
      /unavailable for this owner/,
    );
    assert.equal(requests, 1, 'An unenrolled non-admin cannot send a create to the owned node');
    const farmContexts = (await nativeCatalog(farm.id)).contexts;
    assert.ok(
      farmContexts.some(
        (item) => item.slotId === 'macwork-fixture' && item.executionNodeId === 'local',
      ),
    );
    assert.ok(
      farmContexts.some(
        (item) => item.slotId === 'macpro-fixture' && item.executionNodeId === 'macpro',
      ),
    );
    assert.ok(!farmContexts.some((item) => item.executionNodeId === 'macwork'));
    valid = false;
    assert.deepEqual((await nativeCatalog(person.id)).contexts, []);
  } finally {
    unregisterByWs(socket);
    unregisterByWs(remote);
  }
});

test('an explicit same-host node keeps its own model restriction', async () => {
  nodeModelCatalogs.record('pi', 'macwork', ['litellm/glm-5p3']);
  nodeModelCatalogs.record('pi', 'macpro', ['xai/grok-4.7']);
  assert.equal(await nativeModelNodeBlocker('pi', 'litellm/glm-5p3', 'macwork'), null);
  assert.ok(await nativeModelNodeBlocker('pi', 'xai/grok-4.7', 'macwork'));
  assert.ok(await nativeModelNodeBlocker('pi', 'xai/grok-4.7', 'local'));
});

test('delegated local target uses its actual pool machine model catalog', async () => {
  nodeModelCatalogs.record('pi', 'macwork', ['litellm/glm-5p3']);
  const catalog = await nativeCatalog(person.id, true, person);
  const pi = catalog.runners.find((runner) => runner.runner === 'pi');
  assert.deepEqual(pi?.nodeModels?.local, ['litellm/glm-5p3']);
  assert(
    catalog.contexts.some(
      (context) => context.executionNodeId === 'local' && context.slotId === 'macwork-fixture',
    ),
  );
});
