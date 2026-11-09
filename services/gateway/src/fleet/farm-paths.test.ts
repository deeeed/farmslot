import { assertStatusFileWritable } from '../projects/repo-root.js';
import { machineShellEnv } from '../core/project-env.js';
import { commandIncludesRemotePath, shellExpressionForRemotePath } from '../core/remote-paths.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import { resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { reportedFarmPaths } from '@farmslot/slot-config';

import { hostIdentityInspectionCommand } from '../runners/provider-account-host.js';
import { buildRunnerObservabilityInstallCommand } from '../runners/runner-observability.js';
import { remapRemoteFarmRefs } from '../node-support/remote-command.js';
import {
  agentRuntimeScriptForSlot,
  farmslotDirectoryForSlot,
} from '../tasks/agent-runtime-script.js';
import { resourceRevisions } from '../resources/revisions.js';
import { farmPathsForSlot } from './farm-paths.js';
import { getNode, registerNode, unregisterByWs } from './machine-registry.js';

// A real typed fixture keeps this test honest when SlotVars gains required fields.
import { type SlotVars } from '@farmslot/slot-config';
const vars: SlotVars = {
  slotId: 'paths-slot',
  machine: 'paths-node',
  host: 'paths-node.invalid',
  platform: 'cli',
  sshUser: 'test',
  osType: 'darwin',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: '/repo',
  session: 'paths-slot',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'paths-node.invalid',
  remoteRepo: '/repo',
  projectName: 'test',
  machineEnv: {},
  resourceVars: {},
};

test('node report stays with its connection, selects remote helpers, and replacement restores legacy fallbacks', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'node-farm-paths-'));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/instance.json'), '{"layout":2}');
  const report = resolveFarmPaths({ role: 'node', home: root, checkoutRoot: '/unused', env: {} });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const olderSocket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await Promise.all([once(socket, 'open'), once(olderSocket, 'open')]);
  t.after(() => {
    unregisterByWs(socket);
    unregisterByWs(olderSocket);
    resourceRevisions.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  registerNode(
    vars.machine,
    1,
    socket,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { node: {}, farmPaths: report },
  );
  assert.strictEqual(getNode(vars.machine)?.farmPaths, report);
  assert.strictEqual(reportedFarmPaths(vars.machine), report);
  const env = machineShellEnv({ ...vars, machineEnv: { FARMSLOT_POOL_DIR: '/stale-pool' } });
  assert.equal(env.FARMSLOT_POOL_DIR, report.pool);
  assert.equal(env.FARMSLOT_PROJECTS_DIR, report.projects);
  assert.equal(env.FARMSLOT_CLI, path.join(report.code.bin, 'farmslot'));
  assert.equal(farmPathsForSlot(vars).code.support, path.join(root, 'code/support'));
  assert.equal(await farmslotDirectoryForSlot(vars), report.code.node);
  assert.equal(
    await agentRuntimeScriptForSlot(vars, 'task-init-cli.mjs'),
    path.join(report.code.agentRuntimeScripts, 'task-init-cli.mjs'),
  );
  assert.ok(hostIdentityInspectionCommand(vars, 'codex').includes(report.code.node));
  const install = buildRunnerObservabilityInstallCommand(vars, 'codex', '/repo');
  assert.ok(install.includes(report.code.support));
  assert.ok(install.includes(report.code.node));
  const helper = `${report.code.node}/scripts/helper.mjs`;
  assert.equal(
    remapRemoteFarmRefs(`node '${helper}'`, '/selected/support', ['scripts'], report.code.node),
    "node '/selected/support/scripts/helper.mjs'",
  );
  registerNode(vars.machine, 2, olderSocket);
  assert.equal(unregisterByWs(socket), null);
  assert.equal(reportedFarmPaths(vars.machine), undefined);
  assert.equal(farmPathsForSlot(vars).code.node, '~/farmslot-node');
  assert.ok(
    hostIdentityInspectionCommand(vars, 'codex').includes(
      'farmslot-node/scripts/provider-account-cli.mjs',
    ),
  );
  assert.ok(
    buildRunnerObservabilityInstallCommand(vars, 'codex', '/repo').includes(
      'farmslot-node/support',
    ),
  );
  assert.equal(unregisterByWs(olderSocket), vars.machine);
});

test('reported paths with apostrophes still remap quoted helpers to immutable support', () => {
  const root = "/tmp/Arthur's farm/code/node";
  const support = "/tmp/Arthur's farm/code/support/hash";
  const command = `node ${shellExpressionForRemotePath(`${root}/scripts/helper.mjs`)}`;
  assert.equal(commandIncludesRemotePath(command, root), true);
  assert.equal(
    remapRemoteFarmRefs(command, support, ['scripts'], root),
    `node ${shellExpressionForRemotePath(`${support}/scripts/helper.mjs`)}`,
  );
});

test('layout-2 status writes require the same gateway authority as the legacy status store', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'status-farm-paths-'));
  const previous = process.env.FARMSLOT_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/instance.json'), '{"layout":2}');
  process.env.FARMSLOT_HOME = root;
  const file = path.join(root, 'state/status.json');
  assert.throws(
    () => assertStatusFileWritable(file, '/unused', false),
    /writes require gateway bootstrap/,
  );
  assert.doesNotThrow(() => assertStatusFileWritable(file, '/unused', true));
});
