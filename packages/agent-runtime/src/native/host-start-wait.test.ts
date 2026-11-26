// A host replays every session journal before it listens: 18 s on a node with 477 of them.
// The start used to give up after a fixed 10 s while that supervisor was still starting, so a
// node's startup warm threw and the node exited. These fake supervisors write host.json at once
// and become ready only later.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RUNTIME_VERSION } from '../version.js';

import { type NativeHostStartLimits, NativeSessionClient } from './client.js';
import { NATIVE_HOST_UNAVAILABLE } from './host-unavailable.js';
import { currentRuntimeBuild } from './runtime-build.js';

const LIMITS: NativeHostStartLimits = { timeoutMs: 6_000, noProgressMs: 1_500, progressMs: 500 };

/** A supervisor stand-in: claims the host now, is ready after `readyAfterMs`, or exits early. */
function fakeSupervisor(
  root: string,
  { readyAfterMs, exitAfterMs }: { readyAfterMs?: number; exitAfterMs?: number },
): ChildProcess {
  const script = `
    const fs = require('node:fs'); const path = require('node:path');
    const root = ${JSON.stringify(root)};
    const socket = path.join(root, 'socket');
    fs.writeFileSync(path.join(root, 'host.json'), JSON.stringify({
      pid: process.pid, socket, token: 't', executionNodeId: 'local',
      runtimeVersion: ${JSON.stringify(RUNTIME_VERSION)},
      runtimeBuild: ${JSON.stringify(currentRuntimeBuild())},
    }), { mode: 0o600 });
    ${readyAfterMs === undefined ? '' : `setTimeout(() => { fs.writeFileSync(socket, ''); fs.writeFileSync(path.join(root, 'ready.json'), '{}'); }, ${readyAfterMs});`}
    setTimeout(() => process.exit(${exitAfterMs === undefined ? 0 : 1}), ${exitAfterMs ?? 8_000});
  `;
  return spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
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

function home(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'native-host-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Until the fake supervisor has claimed the host. */
async function claimed(root: string): Promise<void> {
  while (!existsSync(join(root, 'host.json'))) await new Promise((r) => setTimeout(r, 10));
}

function stopAfter(t: test.TestContext, child: ChildProcess): ChildProcess {
  t.after(() => {
    child.kill();
  });
  return child;
}

test('a start waits past the no-progress bound while its own supervisor is still starting', async (t) => {
  const root = home(t);
  const client = new FakeStartClient(root, () =>
    stopAfter(t, fakeSupervisor(root, { readyAfterMs: 2_500 })),
  );
  const started = Date.now();
  await client.warm();
  assert.ok(Date.now() - started > LIMITS.noProgressMs, 'ready only after the no-progress bound');
  assert.equal(client.spawned, 1);
});

test('a start whose supervisor dies before ready fails at once, not at the start timeout', async (t) => {
  const root = home(t);
  const client = new FakeStartClient(root, () =>
    stopAfter(t, fakeSupervisor(root, { exitAfterMs: 100 })),
  );
  const started = Date.now();
  await assert.rejects(client.warm(), { code: NATIVE_HOST_UNAVAILABLE });
  assert.ok(Date.now() - started < LIMITS.noProgressMs, `failed after ${Date.now() - started} ms`);
});

test('a client waits for a supervisor already starting instead of spawning a duplicate', async (t) => {
  const root = home(t);
  stopAfter(t, fakeSupervisor(root, { readyAfterMs: 1_000 }));
  await claimed(root);
  const client = new FakeStartClient(root, () => {
    throw new Error('a starting host must not get a second supervisor');
  });
  await client.warm();
  assert.equal(client.spawned, 0);
});

test('a client whose starting supervisor dies starts a host of its own', async (t) => {
  const root = home(t);
  stopAfter(t, fakeSupervisor(root, { exitAfterMs: 300 }));
  await claimed(root);
  const client = new FakeStartClient(root, () =>
    stopAfter(t, fakeSupervisor(root, { readyAfterMs: 200 })),
  );
  await client.warm();
  assert.equal(client.spawned, 1);
});
