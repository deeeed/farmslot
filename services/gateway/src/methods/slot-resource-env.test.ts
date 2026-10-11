import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { SlotVars } from '../core/config.js';

const exec = promisify(execFile);
let local = true;
const poolValue = "/configured path/it's literal $(false)";
const command = `test "$PROJECT_ONLY" = project && test "$FARMSLOT_MACHINE" = fixture-node && printf '%s' "$NODE_BIN"`;
const vars: SlotVars = {
  slotId: 'fixture-slot',
  machine: 'fixture-node',
  host: 'localhost',
  repo: tmpdir(),
  remoteRepo: tmpdir(),
  platform: 'web',
  sshUser: 'fixture',
  osType: 'linux',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  session: 'fixture-session',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'fixture@fixture-node',
  projectName: 'fixture-project',
  resourceVars: {},
  machineEnv: { NODE_BIN: poolValue },
};
const projectJson = {
  command_env: { unset: ['NODE_BIN'], set: { NODE_BIN: '/wrong', PROJECT_ONLY: 'project' } },
  slot_actions: {
    run: { label: 'Run', command, refresh: ['none'] },
    copy: { label: 'Copy', command, mode: 'copy' },
  },
  resources: {
    worker: { type: 'dev-server', label: 'Worker', hooks: { boot: command, health: command } },
  },
};
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => ({ projectJson }),
    resolveSlot: async () => ({
      pool: { project: 'fixture-project' },
      slot: { resources: { worker: {} } },
    }),
  },
});
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    isLocal: () => local,
    execLocal: async (cmd: string) => {
      const { stdout, stderr } = await exec('bash', ['-c', cmd]);
      return { stdout, stderr, exitCode: 0 };
    },
  },
});
const registry = await import('../fleet/machine-registry.js');
mock.module('../fleet/machine-registry.js', {
  namedExports: { ...registry, getNode: () => ({ gatewayUrl: 'http://fixture-gateway' }) },
});
const rpc = await import('../fleet/node-rpc.js');
const sent: string[] = [];
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    ...rpc,
    getSlotLocality: async () => ({ isLocal: local, machine: vars.machine }),
    sendNodeRequest: async (_node: unknown, method: string, input: { cmd: string }) => {
      assert.equal(method, 'exec');
      sent.push(input.cmd);
      // Run the exact request payload in a child shell, without a node or server.
      const { stdout, stderr } = await exec('bash', ['-c', input.cmd]);
      return { stdout, stderr, exitCode: 0 };
    },
  },
});
mock.module('../node-support/remote-command.js', {
  namedExports: { resolveRemoteFarmCommand: async (_vars: unknown, cmd: string) => cmd },
});
// Resource control's asynchronous refresh must not read operator fleet state.
const state = await import('../fleet/state.js');
mock.module('../fleet/state.js', {
  namedExports: {
    ...state,
    getCachedFleet: () => undefined,
    loadFleetStatus: async () => ({ slots: [] }),
  },
});
const { slotActionRun } = await import('./slot-actions.js');
const { executeResourceHealth, executeResourceControl } =
  await import('../fleet/resource-manager.js');

for (const locality of ['local', 'remote'] as const) {
  test(`${locality} slot action exports pool values into the child shell`, async () => {
    local = locality === 'local';
    const result = await slotActionRun({ slotId: vars.slotId, actionId: 'slot:run' });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.stdout, poolValue);
    if (!local) assert.match(sent.at(-1)!, /export NODE_BIN=/);
  });

  test(`${locality} resource health and control export pool values into child shells`, async () => {
    local = locality === 'local';
    const health = await executeResourceHealth(vars.slotId, 'worker');
    assert.equal(health.ok, true, health.detail);
    const control = await executeResourceControl(vars.slotId, 'worker', 'boot');
    assert.equal(control.ok, true, control.detail);
    assert.equal(control.detail, poolValue);
    if (!local) assert.match(sent.at(-1)!, /export NODE_BIN=/);
  });
}

test('copy actions retain the resolved operator command', async () => {
  const result = await slotActionRun({ slotId: vars.slotId, actionId: 'slot:copy' });
  assert.equal(result.command, command);
});
