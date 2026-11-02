import assert from 'node:assert/strict';
import os from 'node:os';
import { mock, test } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import type { Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const execution = await import('../core/exec.js');
const { NodeExecUnconfirmedError } = await import('../fleet/node-rpc.js');
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const templates = await import('./templates.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const vars = makeVars({ projectName: 'read-probes', remoteRepo: '/fixture/terminal' });
let execute: typeof execution.execOnSlot = async () => ({ stdout: '', stderr: '', exitCode: 0 });
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    resolveProjectRuntimeDir: async () => 'temp/farmslot',
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: (...args: Parameters<typeof execute>) => execute(...args),
  },
});
mock.module('./templates.js', {
  namedExports: { ...templates, resolveWorkerTaskDir: async () => 'temp/tasks/chart' },
});
// The gateway facade can load the probe before module mocks are installed.
// Re-import its real implementation with the mocked execution boundary.
const probeModule: string = '../core/read-probes.js?bounded-read-probes';
const probes: typeof import('../core/read-probes.js') = await import(probeModule);
mock.module('../core/read-probes.js', { namedExports: { ...probes } });
const reviewedModule: string = './reviewed-inputs.js?bounded-read-probes';
const { readReviewedInputs }: typeof import('./reviewed-inputs.js') = await import(reviewedModule);
const observabilityModule: string = '../runners/observability-files.js?bounded-read-probes';
const {
  readRunnerObservabilityFiles,
  readRunnerSessionObservabilityState,
  readRunnerPaneObservabilityState,
}: typeof import('../runners/observability-files.js') = await import(observabilityModule);
const run: Pick<Run, 'id' | 'project' | 'taskFile' | 'slotId'> = {
  id: 'chart-read-probe',
  project: vars.projectName,
  taskFile: '/fixture/TASK.md',
  slotId: vars.slotId,
};

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('a 31-slot local burst admits four fingerprints and queued readers keep their command budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hold = latch();
  let active = 0;
  let peak = 0;
  const started: string[] = [];
  const signals: boolean[] = [];
  let released = false;
  execute = async (slot, _command, options) => {
    assert.ok(options && typeof options === 'object');
    active++;
    peak = Math.max(peak, active);
    started.push(slot.remoteRepo);
    if (!released) await hold.promise;
    signals.push(options.signal?.aborted ?? false);
    active--;
    return { stdout: 'observed', stderr: '', exitCode: 0 };
  };
  const slots = Array.from({ length: 31 }, (_, index) =>
    makeVars({ remoteRepo: `/fixture/workspace-${index}` }),
  );
  const reads = slots.map((slot, index) =>
    probes.readSlotProbe(slot, 'fingerprint', 'workspace', index === 30 ? 10 : 100_000),
  );
  const duplicate = probes.readSlotProbe(slots[30]!, 'fingerprint', 'workspace', 10);
  const settled = Promise.allSettled([...reads, duplicate]);
  try {
    await flush();
    assert.equal(started.length, 4);
    t.mock.timers.tick(20);
  } finally {
    released = true;
    hold.release();
    await settled;
  }
  assert.equal(peak, 4);
  assert.equal(started.length, 31, 'queued duplicates share one pending command');
  assert.ok(
    signals.every((aborted) => !aborted),
    'waiting does not consume the command budget',
  );
  assert.ok((await settled).every((result) => result.status === 'fulfilled'));
});

test('local recovery and remote reads do not queue behind passive local fingerprints', async () => {
  const hold = latch();
  let localStarts = 0;
  execute = async (_slot, command) => {
    if (command === 'blocked local') {
      localStarts++;
      await hold.promise;
    }
    return { stdout: command, stderr: '', exitCode: 0 };
  };
  const occupied = Array.from({ length: 4 }, (_, index) =>
    probes.readSlotProbe(
      makeVars({ remoteRepo: `/fixture/held-${index}` }),
      'blocked local',
      'workspace',
      5000,
    ),
  );
  try {
    await flush();
    assert.equal(localStarts, 4);
    const recovery = probes.readSlotProbe(vars, 'current recovery', 'workspace-recovery', 120_000);
    const remote = probes.readSlotProbe(
      makeVars({ host: 'remote.invalid', machine: 'remote-fixture' }),
      'remote observation',
      'workspace',
      5000,
    );
    assert.equal((await recovery).stdout, 'current recovery');
    assert.equal((await remote).stdout, 'remote observation');
  } finally {
    hold.release();
    await Promise.all(occupied);
  }
});

test(
  'a failed fingerprint releases its permit and the next admitted command still times out',
  { timeout: 2000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const holds = Array.from({ length: 5 }, latch);
    const signals = new Map<number, AbortSignal>();
    const started: number[] = [];
    execute = async (_slot, command, options) => {
      assert.ok(options && typeof options === 'object' && options.signal);
      const index = Number(command);
      signals.set(index, options.signal);
      started.push(index);
      if (index === 4)
        options.signal.addEventListener('abort', holds[index]!.release, { once: true });
      await holds[index]!.promise;
      return {
        stdout: '',
        stderr: '',
        exitCode: index === 0 ? 1 : options.signal.aborted ? 130 : 0,
      };
    };
    const reads = holds.map((_hold, index) =>
      probes.readSlotProbe(
        makeVars({ remoteRepo: `/fixture/failure-${index}` }),
        String(index),
        'workspace',
        index === 4 ? 10 : 100_000,
      ),
    );
    const settled = Promise.allSettled(reads);
    try {
      await flush();
      assert.deepEqual(started, [0, 1, 2, 3]);
      t.mock.timers.tick(20);
      holds[0]!.release();
      await flush();
      assert.deepEqual(started, [0, 1, 2, 3, 4], 'a failed command must free its permit');
      const queued = signals.get(4);
      assert.ok(queued);
      t.mock.timers.tick(9);
      assert.equal(queued.aborted, false);
      t.mock.timers.tick(1);
      assert.equal(queued.aborted, true, 'the full deadline still fires after admission');
    } finally {
      holds.forEach((hold) => hold.release());
      await settled;
    }
    const results = await settled;
    assert.equal(results[0]?.status, 'rejected');
    assert.equal(results[4]?.status, 'rejected');
  },
);

test('concurrent gate readers share one slow evidence fingerprint, then refresh after settlement', async () => {
  const hold = latch();
  let fingerprints = 0;
  execute = async () => {
    fingerprints++;
    await hold.promise;
    return { stdout: 'frozen-head\nevidence hash\n', stderr: '', exitCode: 0 };
  };
  const readers = Array.from({ length: 100 }, () => readReviewedInputs(run));
  try {
    await flush();
    assert.equal(fingerprints, 1, 'one pending node command per run');
  } finally {
    hold.release();
    await Promise.all(readers);
  }
  await readReviewedInputs(run);
  assert.equal(fingerprints, 2, 'settled values do not mask later evidence changes');
});

test('concurrent progress consumers share the same slow hooks and statusline read', async () => {
  const hold = latch();
  let hooks = 0;
  let statuslines = 0;
  execute = async (_slot, command) => {
    if (command.includes('install.json')) return { stdout: 'external', stderr: '', exitCode: 0 };
    if (command.includes('tail -c')) hooks++;
    else statuslines++;
    await hold.promise;
    return { stdout: '{}', stderr: '', exitCode: 0 };
  };
  const readers = Array.from({ length: 100 }, () => readRunnerObservabilityFiles(vars));
  try {
    await flush();
    assert.equal(hooks, 1, 'activity, turn and background reads share the hooks command');
    assert.equal(statuslines, 1);
  } finally {
    hold.release();
    await Promise.all(readers);
  }
  await readRunnerObservabilityFiles(vars);
  assert.equal(hooks, 2);
});

for (const snapshot of [
  { name: 'session', read: () => readRunnerSessionObservabilityState(vars, 'fixture-session') },
  { name: 'pane', read: () => readRunnerPaneObservabilityState(vars, '%fixture') },
]) {
  test(`concurrent progress readers share one ${snapshot.name} snapshot command`, async () => {
    const hold = latch();
    let reads = 0;
    execute = async (_slot, command) => {
      if (command.includes('install.json')) return { stdout: 'external', stderr: '', exitCode: 0 };
      reads++;
      await hold.promise;
      return { stdout: '{"event":"Stop"}', stderr: '', exitCode: 0 };
    };
    const readers = Array.from({ length: 100 }, () => snapshot.read());
    try {
      await flush();
      assert.equal(reads, 1);
    } finally {
      hold.release();
      await Promise.all(readers);
    }
  });
}

test(
  'a timed-out probe retains its flight until the owned process is killed and reaped',
  { timeout: 10_000 },
  async () => {
    const started = latch();
    const aborted = latch();
    let launches = 0;
    let childPid = 0;
    execute = async (_slot, command, options) => {
      assert.ok(options && typeof options === 'object');
      assert.ok(options.signal, 'the transport must own cancellation and closeout');
      assert.equal(options.noRetry, true, 'a lost reply must not resend the read');
      launches++;
      options.signal.addEventListener('abort', aborted.release, { once: true });
      return execution.execLocal(command, {
        ...options,
        closeoutTimeoutMs: 25,
        cwd: os.tmpdir(),
        onOutput: (stream, value) => {
          if (stream === 'stdout') {
            childPid = Number(value.trim());
            started.release();
          }
        },
      });
    };
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const script =
      'process.on("SIGTERM",()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)';
    const command = `exec ${quote(process.execPath)} -e ${quote(script)}`;
    const probeVars = { ...vars, remoteRepo: os.tmpdir() };
    const reads = Array.from({ length: 100 }, () =>
      probes.readSlotProbe(probeVars, command, 'reap-fixture', 500),
    );
    const settled = Promise.allSettled(reads);
    await started.promise;
    await aborted.promise;
    const lateReader = probes.readSlotProbe(probeVars, command, 'reap-fixture', 500);
    const lateResult = Promise.allSettled([lateReader]);
    try {
      assert.equal(launches, 1, 'abort begins cleanup, it does not release the flight');
      assert.ok(childPid > 0);
    } finally {
      const results = [...(await settled), ...(await lateResult)];
      assert.ok(results.every((result) => result.status === 'rejected'));
    }
    assert.equal(launches, 1);
    assert.throws(
      () => process.kill(childPid, 0),
      { code: 'ESRCH' },
      'the process has been reaped before readers settle',
    );
  },
);

test('unconfirmed closeout does not admit another probe on the same node connection', async () => {
  const failure = new NodeExecUnconfirmedError(vars.machine, 'fixture-request', 'timeout');
  let launches = 0;
  execute = async () => {
    launches++;
    throw failure;
  };
  await assert.rejects(
    probes.readSlotProbe(vars, 'fixture read', 'unconfirmed-fixture', 100),
    (error: unknown) => error === failure,
  );
  const results = await Promise.allSettled(
    Array.from({ length: 100 }, () =>
      probes.readSlotProbe(vars, 'fixture read', 'unconfirmed-fixture', 100),
    ),
  );
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason === failure));
  assert.equal(launches, 1);
});

test('a late closeout from the node admits the next probe on the same connection', async () => {
  // F298: one slow workspace read on loaded macpro hid macpro-audiolab-1's workspace (and with it
  // every recovery) until the node reconnected, long after the node had answered.
  let confirm!: () => void;
  const failure = new NodeExecUnconfirmedError(
    vars.machine,
    'late-request',
    'timeout',
    undefined,
    new Promise<void>((resolve) => {
      confirm = resolve;
    }),
  );
  let launches = 0;
  execute = async () => {
    launches++;
    if (launches === 1) throw failure;
    return { stdout: 'fresh', stderr: '', exitCode: 0 };
  };
  const read = () => probes.readSlotProbe(vars, 'late read', 'late-closeout-fixture', 100);
  await assert.rejects(read(), (error: unknown) => error === failure);
  await assert.rejects(read(), (error: unknown) => error === failure);
  assert.equal(launches, 1, 'held until the node confirms');
  confirm();
  await flush();
  assert.equal((await read()).stdout, 'fresh');
  assert.equal(launches, 2);
});

/** A node-side socket of a real local WebSocket connection, torn down after the test. */
async function connectedSocket(t: test.TestContext): Promise<WebSocket> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let client: WebSocket | undefined;
  t.after(async () => {
    client?.terminate();
    for (const socket of server.clients) {
      unregisterByWs(socket);
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise<void>((resolve, reject) =>
    server.once('listening', resolve).once('error', reject),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const peer = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
  const connection = new WebSocket(`ws://127.0.0.1:${address.port}`);
  client = connection;
  await new Promise<void>((resolve, reject) =>
    connection.once('open', resolve).once('error', reject),
  );
  const socket = await peer;
  return socket;
}

test('a late closeout from a replaced connection leaves the replacement probe in flight', async (t) => {
  // The registry replaces a node without closing its old socket, which can still deliver what it
  // owed; that must not drop the probe the replacement connection is running.
  const socket = await connectedSocket(t);
  let confirm!: () => void;
  const failure = new NodeExecUnconfirmedError(
    vars.machine,
    'replaced-request',
    'timeout',
    undefined,
    new Promise<void>((resolve) => {
      confirm = resolve;
    }),
  );
  const hold = latch();
  let launches = 0;
  execute = async () => {
    launches++;
    if (launches === 1) throw failure;
    await hold.promise;
    return { stdout: 'replacement', stderr: '', exitCode: 0 };
  };
  const read = () => probes.readSlotProbe(vars, 'replaced read', 'replaced-fixture', 100);
  await assert.rejects(read(), (error: unknown) => error === failure);
  registerNode(vars.machine, 1, socket);
  const inFlight = read();
  await flush();
  assert.equal(launches, 2, 'the replacement connection probes again');
  confirm();
  await flush();
  const shared = read();
  await flush();
  assert.equal(launches, 2, 'the old closeout did not drop the replacement flight');
  hold.release();
  assert.equal((await inFlight).stdout, 'replacement');
  assert.equal((await shared).stdout, 'replacement');
});

test('a probe that waits for reconnect retains the connection that actually executed it', async (t) => {
  const socket = await connectedSocket(t);
  let launches = 0;
  execute = async () => {
    launches++;
    registerNode(vars.machine, 1, socket);
    throw new NodeExecUnconfirmedError(vars.machine, 'reconnected-request', 'timeout', socket);
  };
  await assert.rejects(probes.readSlotProbe(vars, 'reconnect read', 'reconnect-fixture', 100));
  await Promise.allSettled(
    Array.from({ length: 100 }, () =>
      probes.readSlotProbe(vars, 'reconnect read', 'reconnect-fixture', 100),
    ),
  );
  assert.equal(
    launches,
    1,
    'socket B must not be mistaken for a replacement of an undefined socket',
  );
});
