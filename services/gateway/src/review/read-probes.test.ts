import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import type { NodeFsReadTextParams, Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const execution = await import('../core/exec.js');
const { NodeExecUnconfirmedError, handleNodeResponse } = await import('../fleet/node-rpc.js');
const nodeFs = await import('../../../node/src/commands/fs.js');
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const templates = await import('./templates.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const vars = makeVars({ projectName: 'read-probes', remoteRepo: '/fixture/terminal' });
// Remote slots whose node declares no text reads read runner files through the node's shell;
// local slots read them in-process.
const remoteVars = { ...vars, host: 'remote-fixture', machine: 'remote-fixture-node' };
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
// slot-files.ts uses execOnSlot from exec.js and readSlotProbe from read-probes.js. Load it fresh
// with the mocked execution boundary (same pattern as observability-files below) so its shell-read
// path goes through the test's execute stub rather than the real node-exec layer.
const slotFilesModule: string = '../host-services/slot-files.js?bounded-read-probes';
const freshSlotFiles: typeof import('../host-services/slot-files.js') = await import(
  slotFilesModule
);
// Use a mutable impl so the EPERM test can swap in an fs-mocked version without re-mocking the
// module (Node.js rejects a second mock.module on a module already mocked at the outer level).
let _slotFilesImpl = freshSlotFiles.default;
// Node 22 cannot mock a module whose named exports include `default`: it goes in defaultExport.
const { default: _freshSlotFilesDefault, ...freshSlotFilesNamed } = freshSlotFiles;
mock.module('../host-services/slot-files.js', {
  namedExports: freshSlotFilesNamed,
  defaultExport: {
    read: (...args: Parameters<typeof _slotFilesImpl.read>) => _slotFilesImpl.read(...args),
    tail: (...args: Parameters<typeof _slotFilesImpl.tail>) => _slotFilesImpl.tail(...args),
    isFile: (...args: Parameters<typeof _slotFilesImpl.isFile>) => _slotFilesImpl.isFile(...args),
  },
});
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
    if (command.includes('install.json')) return { stdout: '1', stderr: '', exitCode: 0 };
    if (command.includes('tail -c')) hooks++;
    else statuslines++;
    await hold.promise;
    return { stdout: '{}', stderr: '', exitCode: 0 };
  };
  const readers = Array.from({ length: 100 }, () => readRunnerObservabilityFiles(remoteVars));
  try {
    await flush();
    assert.equal(hooks, 1, 'activity, turn and background reads share the hooks command');
    assert.equal(statuslines, 1);
  } finally {
    hold.release();
    await Promise.all(readers);
  }
  await readRunnerObservabilityFiles(remoteVars);
  assert.equal(hooks, 2);
});

for (const snapshot of [
  {
    name: 'session',
    read: () => readRunnerSessionObservabilityState(remoteVars, 'fixture-session'),
  },
  { name: 'pane', read: () => readRunnerPaneObservabilityState(remoteVars, '%fixture') },
]) {
  test(`concurrent progress readers share one ${snapshot.name} snapshot command`, async () => {
    const hold = latch();
    let reads = 0;
    execute = async (_slot, command) => {
      if (command.includes('install.json')) return { stdout: '1', stderr: '', exitCode: 0 };
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

test('a local slot reads runner files in-process and starts no command', async (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'read-probes-local-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const local = { ...vars, remoteRepo: repo };
  // No external install marker: the legacy directory under the repo's runtime dir is used.
  const dir = path.join(repo, 'temp/farmslot/.observability');
  mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const hooks = `${'x'.repeat(70_000)}\n{"event":"Stop"}\n`;
  writeFileSync(path.join(dir, 'hooks.jsonl'), hooks);
  writeFileSync(path.join(dir, 'statusline.json'), '{"ctx":1}');
  writeFileSync(path.join(dir, 'sessions', 'fixture-session.json'), '{"event":"Stop"}');
  let commands = 0;
  execute = async () => {
    commands++;
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const files = await readRunnerObservabilityFiles(local);
  assert.equal(
    files.hooksRaw,
    hooks.slice(-65536),
    'the hooks read keeps the last 64 KiB, as tail -c did',
  );
  assert.equal(files.statuslineRaw, '{"ctx":1}');
  assert.equal(
    (await readRunnerSessionObservabilityState(local, 'fixture-session'))?.event,
    'Stop',
  );
  assert.equal(
    await readRunnerPaneObservabilityState(local, '%missing'),
    null,
    'a missing file reads as empty',
  );
  assert.equal(commands, 0);
});

test('a local runner file the OS refuses (EPERM) reads as empty, as the shell read did', async (t) => {
  const fs = await import('node:fs/promises');
  const refuse = async () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  // Node 22 cannot mock a module whose named exports include `default`: it goes in defaultExport.
  const { default: fsDefault, ...fsNamed } = fs;
  const refused = t.mock.module('node:fs/promises', {
    namedExports: { ...fsNamed, open: refuse, readFile: refuse, stat: refuse },
    defaultExport: { ...fsDefault, open: refuse, readFile: refuse, stat: refuse },
  });
  t.after(() => refused.restore());
  // slot-files.ts owns the in-process fs calls; load it fresh after the fs mock so it picks up
  // the EPERM functions rather than the real fs captured when the top-level mock was set up.
  // Swap the mutable impl behind the top-level proxy rather than re-mocking the module.
  const slotFilesEperm: string = '../host-services/slot-files.js?eperm';
  const freshSlotFilesEperm: typeof import('../host-services/slot-files.js') = await import(
    slotFilesEperm
  );
  _slotFilesImpl = freshSlotFilesEperm.default;
  t.after(() => {
    _slotFilesImpl = freshSlotFiles.default;
  });
  const eperm: string = '../runners/observability-files.js?eperm';
  const files: typeof import('../runners/observability-files.js') = await import(eperm);
  let commands = 0;
  execute = async () => {
    commands++;
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const local = { ...vars, remoteRepo: os.tmpdir() };
  assert.deepEqual(await files.readRunnerObservabilityFiles(local), {
    hooksRaw: '',
    statuslineRaw: '',
  });
  assert.equal(await files.readRunnerSessionObservabilityState(local, 'refused'), null);
  assert.equal(commands, 0);
});

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

/** Node requests the far end answers; `undefined` leaves the request unanswered. */
type NodeAnswer = (method: string, params: unknown) => Promise<unknown> | undefined;

/**
 * A node-side socket of a real local WebSocket connection, torn down after the test. With
 * `answer`, the far end replies to gateway requests as services/node does.
 */
async function connectedSocket(t: test.TestContext, answer?: NodeAnswer): Promise<WebSocket> {
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
  if (answer) {
    connection.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { id: string; method: string; params: unknown };
      void answer(frame.method, frame.params)?.then(
        (payload) =>
          connection.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload })),
        (error: NodeJS.ErrnoException) =>
          connection.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: false,
              error: { code: error.code, message: error.message },
            }),
          ),
      );
    });
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as {
        id: string;
        ok: boolean;
        payload?: unknown;
        error?: { code?: string; message: string };
      };
      handleNodeResponse(
        frame.id,
        frame.ok,
        frame.payload,
        frame.error?.message,
        frame.error?.code,
        socket,
      );
    });
  }
  return socket;
}

const nodeFileReads: Record<string, (params: NodeFsReadTextParams) => Promise<unknown>> = {
  'fs.readText': nodeFs.fsReadText,
  'fs.isFile': nodeFs.fsIsFile,
};

/** A remote slot on a temp repo whose connected node answers with the real node file reads. */
async function remoteSlotWithNode(
  t: test.TestContext,
  options: { textReads: boolean; hold?: Promise<void> },
) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'read-probes-remote-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  mkdirSync(repo);
  // A repo-relative runtime dir is kept beside the repo: <parent>/.farmslot-runtime/<repo>/…
  const runtime = path.join(parent, '.farmslot-runtime', 'repo');
  const methods: string[] = [];
  const socket = await connectedSocket(t, (method, params) => {
    methods.push(method);
    const read = nodeFileReads[method];
    if (!read) return Promise.reject(new Error(`Unexpected ${method}`));
    return (options.hold ?? Promise.resolve()).then(() => read(params as NodeFsReadTextParams));
  });
  const machine = `read-probes-node-${path.basename(parent)}`;
  registerNode(
    machine,
    1,
    socket,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.textReads ? { textReads: 1 } : {},
  );
  const slot = { ...vars, host: '203.0.113.20', machine, remoteRepo: repo };
  const external = path.join(runtime, 'temp/farmslot/.observability');
  return { slot, methods, external };
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

test('a node that declares text reads answers remote runner file reads without a shell', async (t) => {
  const { slot, methods, external } = await remoteSlotWithNode(t, { textReads: true });
  mkdirSync(path.join(external, 'sessions'), { recursive: true });
  writeFileSync(path.join(external, 'install.json'), '{}');
  const hooks = `${'x'.repeat(70_000)}\n{"event":"Stop"}\n`;
  writeFileSync(path.join(external, 'hooks.jsonl'), hooks);
  writeFileSync(path.join(external, 'statusline.json'), '{"ctx":1}');
  writeFileSync(path.join(external, 'sessions', 'fixture-session.json'), '{"event":"Stop"}');
  let commands = 0;
  execute = async () => {
    commands++;
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const files = await readRunnerObservabilityFiles(slot);
  assert.equal(
    files.hooksRaw,
    hooks.slice(-65536),
    'the node keeps the last 64 KiB, as tail -c did',
  );
  assert.equal(
    files.statuslineRaw,
    '{"ctx":1}',
    'the install marker selects the external directory',
  );
  assert.equal((await readRunnerSessionObservabilityState(slot, 'fixture-session'))?.event, 'Stop');
  assert.equal(await readRunnerPaneObservabilityState(slot, '%missing'), null);
  assert.equal(commands, 0, 'no shell starts on the node');
  assert.ok(methods.includes('fs.isFile') && methods.includes('fs.readText'));
});

test('concurrent remote readers share one node read per file', async (t) => {
  const hold = latch();
  const { slot, methods, external } = await remoteSlotWithNode(t, {
    textReads: true,
    hold: hold.promise,
  });
  mkdirSync(external, { recursive: true });
  writeFileSync(path.join(external, 'install.json'), '{}');
  writeFileSync(path.join(external, 'hooks.jsonl'), '{"event":"Stop"}\n');
  const readers = Array.from({ length: 100 }, () => readRunnerObservabilityFiles(slot));
  const settled = Promise.all(readers);
  try {
    for (let i = 0; i < 50 && methods.length < 1; i++) await flush();
    assert.deepEqual(methods, ['fs.isFile'], 'one marker read for every reader');
    hold.release();
    await settled;
  } finally {
    hold.release();
  }
  assert.deepEqual(methods.sort(), ['fs.isFile', 'fs.readText', 'fs.readText']);
  await readRunnerObservabilityFiles(slot);
  assert.equal(methods.length, 6, 'a settled read does not mask later changes');
});

test('a node that does not declare text reads keeps the shell read', async (t) => {
  const { slot, methods } = await remoteSlotWithNode(t, { textReads: false });
  const commands: string[] = [];
  execute = async (_slot, command) => {
    commands.push(command);
    return { stdout: command.includes('install.json') ? '' : '{}', stderr: '', exitCode: 0 };
  };
  await readRunnerObservabilityFiles(slot);
  assert.equal(methods.length, 0);
  assert.ok(commands.some((command) => command.includes('tail -c 65536')));
  assert.ok(commands.some((command) => command.startsWith('if [ -f ')));
});
