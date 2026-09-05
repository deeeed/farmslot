import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// executeResourceControl is the one place a slot resource's boot, shutdown, or
// relaunch hook actually runs, whether a restore called it directly or a
// capability acquire reached it. Machine parking's restore record is built from
// what it reports, so this asserts the report happens and carries the outcome.
const slot = {
  slot: 'slot-a',
  project: 'test-project',
  resources: {
    'dev-server': { port: 8809 },
    'boot-only': { port: 8810 },
    watched: { port: 8811 },
  },
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
          'dev-server': {
            label: 'Gateway',
            type: 'dev-server',
            hooks: { boot: 'start-it', shutdown: 'stop-it', relaunch: 'bounce-it' },
          },
          // No shutdown hook: a shutdown returns before running anything.
          'boot-only': { label: 'Boot only', type: 'service', hooks: { boot: 'start-it' } },
          // A health hook that says stopped short-circuits the shutdown.
          watched: {
            label: 'Watched',
            type: 'service',
            hooks: { health: 'is-it-up', shutdown: 'stop-it' },
          },
        },
      },
    }),
    loadSlotVars: async () => ({ repo: '/tmp/repo', remoteRepo: '/tmp/repo' }),
  },
});

let unresolved = false;
const realHooks = await import('../core/hooks.js');
mock.module('../core/hooks.js', {
  namedExports: {
    ...realHooks,
    expandTemplate: (cmd: string) => (unresolved ? '{{port}} not configured' : cmd),
  },
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
const {
  captureSlotResourceLifecycle,
  runWithResourceLifecycleContext,
  activeResourceLifecycleCaptures,
} = await import('../core/resource-lifecycle-log.js');

/** Capture what one context id does to one slot while `body` runs. */
async function capture(
  scope: { contextId: string; slotId: string },
  body: () => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const seen: Array<Record<string, unknown>> = [];
  const stop = captureSlotResourceLifecycle(scope, (record) =>
    seen.push(record as unknown as Record<string, unknown>),
  );
  try {
    await runWithResourceLifecycleContext(scope.contextId, body);
  } finally {
    stop();
  }
  return seen;
}

const summarise = (records: Array<Record<string, unknown>>) =>
  records.map((record) => ({
    slotId: record.slotId,
    resourceId: record.resourceId,
    action: record.action,
    ok: record.ok,
  }));

test('running a resource hook reports what it ran and how it went', async () => {
  const seen = await capture({ contextId: 'ctx-1', slotId: 'slot-a' }, async () => {
    exitCode = 0;
    assert.equal((await executeResourceControl('slot-a', 'dev-server', 'boot')).ok, true);
    exitCode = 1;
    assert.equal((await executeResourceControl('slot-a', 'dev-server', 'boot')).ok, false);
  });
  assert.deepEqual(summarise(seen), [
    { slotId: 'slot-a', resourceId: 'dev-server', action: 'boot', ok: true },
    { slotId: 'slot-a', resourceId: 'dev-server', action: 'boot', ok: false },
  ]);
});

test('a control on the same slot from outside the context is not attributed to it', async () => {
  exitCode = 0;
  const seen = await capture({ contextId: 'ctx-2', slotId: 'slot-a' }, async () => {
    // What an operator's resource.control RPC or a cleanup shutdown looks like:
    // same slot, same moment, its own execution context. Attributing it here
    // would fail a restore for an action it never took.
    await executeResourceControl('slot-a', 'dev-server', 'boot');
    await Promise.all([
      executeResourceControl('slot-a', 'dev-server', 'relaunch'),
      runWithResourceLifecycleContext('someone-else', () =>
        executeResourceControl('slot-a', 'dev-server', 'boot'),
      ),
    ]);
  });
  assert.deepEqual(summarise(seen), [
    { slotId: 'slot-a', resourceId: 'dev-server', action: 'boot', ok: true },
    { slotId: 'slot-a', resourceId: 'dev-server', action: 'relaunch', ok: true },
  ]);
});

test('a hook started before the capture and finishing during it is not attributed', async () => {
  exitCode = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Started outside any context, still running when the capture opens.
  const inFlight = (async () => {
    await gate;
    return executeResourceControl('slot-a', 'dev-server', 'boot');
  })();
  const seen = await capture({ contextId: 'ctx-3', slotId: 'slot-a' }, async () => {
    release();
    await inFlight;
    await executeResourceControl('slot-a', 'dev-server', 'shutdown');
  });
  assert.deepEqual(summarise(seen), [
    { slotId: 'slot-a', resourceId: 'dev-server', action: 'shutdown', ok: true },
  ]);
});

test('a control on another slot inside the context is not attributed either', async () => {
  exitCode = 0;
  const seen = await capture({ contextId: 'ctx-4', slotId: 'slot-a' }, async () => {
    await executeResourceControl('slot-b', 'dev-server', 'boot');
    await executeResourceControl('slot-a', 'dev-server', 'boot');
  });
  assert.deepEqual(summarise(seen), [
    { slotId: 'slot-a', resourceId: 'dev-server', action: 'boot', ok: true },
  ]);
});

test('a control that never ran a hook reports nothing', async () => {
  exitCode = 0;
  const seen = await capture({ contextId: 'ctx-5', slotId: 'slot-a' }, async () => {
    // Each of these returns before any hook executes. Reporting them would turn
    // a no-op into a recorded action — and against a retained resource, into a
    // forbidden boot that fails a restore.
    assert.equal((await executeResourceControl('slot-a', 'not-configured', 'boot')).ok, false);
    assert.equal((await executeResourceControl('slot-a', 'boot-only', 'shutdown')).ok, false);
    unresolved = true;
    assert.equal((await executeResourceControl('slot-a', 'dev-server', 'boot')).ok, true);
    unresolved = false;
    // A shutdown whose health hook reports the resource already stopped.
    exitCode = 1;
    assert.equal((await executeResourceControl('slot-a', 'watched', 'shutdown')).ok, true);
    exitCode = 0;
  });
  assert.deepEqual(seen, []);
});

test('the capture is removed when the operation ends, however it ends', async () => {
  const before = activeResourceLifecycleCaptures();
  await capture({ contextId: 'ctx-6', slotId: 'slot-a' }, async () => {
    exitCode = 0;
    await executeResourceControl('slot-a', 'dev-server', 'boot');
  });
  assert.equal(activeResourceLifecycleCaptures(), before, 'a clean exit removes its capture');

  await assert.rejects(
    () =>
      capture({ contextId: 'ctx-7', slotId: 'slot-a' }, async () => {
        throw new Error('restore blew up');
      }),
    /restore blew up/,
  );
  assert.equal(
    activeResourceLifecycleCaptures(),
    before,
    'a throw removes it too; otherwise the closure and its buffer are held for the life of the process',
  );
});
