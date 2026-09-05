import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// executeResourceControl is the one place a slot resource's boot, shutdown, or
// relaunch hook actually runs, whether a restore called it directly or a
// capability acquire reached it. Machine parking's restore record is built from
// what it reports, so this asserts the report happens and carries the outcome.
const slot = {
  slot: 'slot-a',
  project: 'test-project',
  resources: { 'dev-server': { port: 8809 } },
};

// Keep every other export real: other modules in the graph import this one and
// a wholesale replacement would break them.
const realConfig = await import('../core/config.js');

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    resolveSlot: async () => ({ pool: { project: 'test-project' }, slot }),
    loadProjectVars: async () => ({
      projectJson: {
        resources: {
          'dev-server': { label: 'Gateway', type: 'dev-server', hooks: { boot: 'start-it' } },
        },
      },
    }),
    loadSlotVars: async () => ({ repo: '/tmp/repo', remoteRepo: '/tmp/repo' }),
  },
});

const realHooks = await import('../core/hooks.js');
mock.module('../core/hooks.js', {
  namedExports: { ...realHooks, expandTemplate: (cmd: string) => cmd },
});

let exitCode = 0;
const realExec = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    execLocal: async () => ({ stdout: 'booted', stderr: '', exitCode }),
  },
});

const realNodeRpc = await import('./node-rpc.js');
mock.module('./node-rpc.js', {
  namedExports: {
    ...realNodeRpc,
    getSlotLocality: async () => ({ isLocal: true, machine: 'machine-a' }),
    sendNodeRequest: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  },
});

const { executeResourceControl } = await import('./resource-manager.js');
const { captureSlotResourceLifecycle } = await import('../core/resource-lifecycle-log.js');

test('running a resource hook reports what it ran and how it went', async () => {
  const seen: unknown[] = [];
  const stop = captureSlotResourceLifecycle('slot-a', (record) => seen.push(record));
  try {
    exitCode = 0;
    const ok = await executeResourceControl('slot-a', 'dev-server', 'boot');
    assert.equal(ok.ok, true);
    exitCode = 1;
    const failed = await executeResourceControl('slot-a', 'dev-server', 'boot');
    assert.equal(failed.ok, false);
  } finally {
    stop();
  }
  assert.deepEqual(
    seen.map((record) => {
      const entry = record as { slotId: string; resourceId: string; action: string; ok: boolean };
      return {
        slotId: entry.slotId,
        resourceId: entry.resourceId,
        action: entry.action,
        ok: entry.ok,
      };
    }),
    [
      { slotId: 'slot-a', resourceId: 'dev-server', action: 'boot', ok: true },
      { slotId: 'slot-a', resourceId: 'dev-server', action: 'boot', ok: false },
    ],
  );
});

test('a listener only hears its own slot, and hears nothing after it stops', async () => {
  const other: unknown[] = [];
  const stop = captureSlotResourceLifecycle('slot-b', (record) => other.push(record));
  exitCode = 0;
  await executeResourceControl('slot-a', 'dev-server', 'boot');
  assert.deepEqual(other, [], 'slot-b must not hear slot-a');
  stop();

  const after: unknown[] = [];
  const stopA = captureSlotResourceLifecycle('slot-a', (record) => after.push(record));
  stopA();
  await executeResourceControl('slot-a', 'dev-server', 'boot');
  assert.deepEqual(after, [], 'a stopped listener must not hear a later occupant');
});
