// A host replays every session journal before it listens: 18 s on a node with 477 of them.
// The start used to give up after a fixed 10 s while that supervisor was still starting, so a
// node's startup warm threw and the node exited. Here a stand-in supervisor (a sleeping child)
// claims the host as a real one does: lock/owner.json with its start identity, then host.json;
// the test makes it ready when it chooses.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RUNTIME_VERSION } from '../version.js';

import { type NativeHostStartLimits, NativeSessionClient } from './client.js';
import { NATIVE_HOST_UNAVAILABLE } from './host-unavailable.js';
import { currentRuntimeBuild } from './runtime-build.js';
import { processStartIdentity } from './storage.js';

const LIMITS: NativeHostStartLimits = { timeoutMs: 1_500, noProgressMs: 400, progressMs: 200 };

const write = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

/** Claims the host for `pid` as a supervisor does, with `identity` as its recorded start. */
function claim(root: string, pid: number, identity = processStartIdentity(pid)): void {
  mkdirSync(join(root, 'lock'), { recursive: true, mode: 0o700 });
  write(join(root, 'lock', 'owner.json'), { pid, identity });
  write(join(root, 'cleanup.json'), { hostPid: pid, state: 'pending' });
  write(join(root, 'host.json'), {
    pid,
    socket: join(root, 'socket'),
    token: 't',
    executionNodeId: 'local',
    runtimeVersion: RUNTIME_VERSION,
    runtimeBuild: currentRuntimeBuild(),
  });
}

function ready(root: string): void {
  writeFileSync(join(root, 'socket'), '');
  write(join(root, 'ready.json'), {});
}

class FakeStartClient extends NativeSessionClient {
  spawned = 0;
  constructor(
    root: string,
    private readonly supervisor: () => ChildProcess,
  ) {
    super(root, 'local', currentRuntimeBuild, undefined, LIMITS);
  }
  protected override spawnSupervisor(): ChildProcess {
    this.spawned += 1;
    return this.supervisor();
  }
}

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'native-host-start-'));
  const children: ChildProcess[] = [];
  t.after(() => {
    for (const child of children) child.kill();
    rmSync(root, { recursive: true, force: true });
  });
  /** A stand-in supervisor process: sleeps, or exits with `code` after `seconds`. */
  const child = (seconds = 20, code = 0) => {
    const process = spawn('/bin/sh', ['-c', `sleep ${seconds}; exit ${code}`], { stdio: 'ignore' });
    children.push(process);
    return process;
  };
  /** A supervisor of ours that claims the host now and is ready after `readyAfterMs`. */
  const starting = (readyAfterMs: number) => {
    const process = child();
    claim(root, process.pid!);
    setTimeout(() => ready(root), readyAfterMs).unref();
    return process;
  };
  return { root, child, starting };
}

test('a start waits past the no-progress bound while its own supervisor is still starting', async (t) => {
  const { root, starting } = setup(t);
  const warned = t.mock.method(console, 'warn', () => {});
  let pid = 0;
  const client = new FakeStartClient(root, () => {
    const process = starting(LIMITS.noProgressMs + 400);
    pid = process.pid!;
    return process;
  });
  const started = Date.now();
  await client.warm();
  assert.ok(Date.now() - started > LIMITS.noProgressMs, 'ready only after the no-progress bound');
  assert.equal(client.spawned, 1);
  assert.match(
    String(warned.mock.calls[0]?.arguments[0]),
    new RegExp(`Waiting for native host supervisor ${pid} to become ready .*host\\.log`),
  );
});

test('a start whose supervisor exits abnormally fails at once, not at the no-progress bound', async (t) => {
  const { root, child } = setup(t);
  const client = new FakeStartClient(root, () => child(0, 1));
  const started = Date.now();
  await assert.rejects(client.warm(), { code: NATIVE_HOST_UNAVAILABLE });
  assert.ok(Date.now() - started < LIMITS.noProgressMs, `failed after ${Date.now() - started} ms`);
});

test('a client waits for a supervisor already starting instead of spawning a duplicate', async (t) => {
  const { root, starting } = setup(t);
  starting(600);
  const client = new FakeStartClient(root, () => {
    throw new Error('a starting host must not get a second supervisor');
  });
  await client.warm();
  assert.equal(client.spawned, 0);
});

test('a client whose starting supervisor stops before ready starts a host of its own', async (t) => {
  const { root, child, starting } = setup(t);
  claim(root, child(0.3).pid!);
  const client = new FakeStartClient(root, () => starting(100));
  await client.warm();
  assert.equal(client.spawned, 1);
});

test('a supervisor that stays alive but never becomes ready fails at the start timeout', async (t) => {
  const { root, child } = setup(t);
  t.mock.method(console, 'warn', () => {});
  claim(root, child().pid!);
  const client = new FakeStartClient(root, () => {
    throw new Error('a live starting supervisor must not get a second one');
  });
  const started = Date.now();
  await assert.rejects(client.warm(), { code: NATIVE_HOST_UNAVAILABLE });
  assert.ok(Date.now() - started >= LIMITS.timeoutMs);
  assert.equal(client.spawned, 0);
});

test('a host.json whose PID now belongs to another process does not count as starting', async (t) => {
  const { root, starting } = setup(t);
  // After a reboot or a kill the recorded PID can run something else: here, this test process,
  // with a start identity that is not the one the supervisor recorded.
  claim(root, process.pid, 'Thu Jan  1 00:00:00 1970');
  const client = new FakeStartClient(root, () => starting(100));
  await client.warm();
  assert.equal(client.spawned, 1);
});

test('a supervisor whose stop failed does not count as starting', async (t) => {
  const { root, child, starting } = setup(t);
  claim(root, child().pid!);
  write(join(root, 'cleanup.json'), { state: 'unknown' });
  const client = new FakeStartClient(root, () => starting(100));
  await client.warm();
  assert.equal(client.spawned, 1);
});
