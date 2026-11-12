// A branch source that fails refuses every observed fleet read. A client on entity sync reads
// nothing for an unchanged slot, so the fleet's membership marker moves when the source settles
// refused or admitted again (ADR-071 Amendment 3): its versions read then meets that refusal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import WebSocket from 'ws';

import type { FleetStatus, ResponseFrame } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { makeVars } = await import('../runners/test-fixtures.js');

const SLOT = 'branch-outcome-slot';
const repo = mkdtempSync(path.join(tmpdir(), 'farmslot-branch-outcome-'));
execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
const head = path.join(repo, '.git', 'HEAD');

const realConfig = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () =>
      makeVars({ slotId: SLOT, machine: 'branch-outcome', host: 'localhost', remoteRepo: repo }),
  },
});

const { createGatewayAuthRuntime } = await import('../security/auth.js');
const { createWebSocketServer } = await import('../server.js');
const { setCachedFleetForTests } = await import('../fleet/state.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { assertBranchObservationsAdmitted, unwatchBranch, watchBranch } =
  await import('./branch-watcher.js');

const fleetKey = { family: 'slots', scope: 'farm' } as const;
const marker = () => resourceRevisions.membershipRevision(fleetKey);

const fleet: FleetStatus = {
  checkedAt: '2026-11-12T00:00:00.000Z',
  slots: [
    {
      slot: SLOT,
      machine: 'branch-outcome',
      platform: 'macos',
      project: 'demo',
      // No workspace inspection: this test reads the branch source only.
      health: { ssh: 'FAIL', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
      branch: 'main',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'ready',
      phase: null,
      warm: false,
      taskId: null,
      taskFile: null,
      dispatchedAt: null,
      completedAt: null,
      runner: null,
      model: null,
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    },
  ],
  summary: {
    total: 1,
    ready: 1,
    busy: 0,
    held: 0,
    manual: 0,
    disabled: 0,
    blocked: 0,
    warmCount: 0,
  },
};

/** Waits for `met`, one event-loop turn at a time, or fails with `what` after three seconds. */
async function until(met: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await met())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const admitted = () =>
  assertBranchObservationsAdmitted().then(
    () => true,
    () => false,
  );

test('a branch source that settles refused or admitted again moves the fleet marker once', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-branch-outcome-home-'));
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const server = createServer();
  const wss = createWebSocketServer(server, auth);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  const principal = auth.writer.createPrincipal(
    { type: 'service', displayName: 'branch outcome reader' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  const credential = auth.writer.issueCredential(principal.id, 'branch outcome test');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  setCachedFleetForTests(fleet);
  t.after(async () => {
    await unwatchBranch(SLOT);
    setCachedFleetForTests(null);
    ws.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let requestId = 0;
  /** An observed read through the production server, as the client cache sends it. */
  const read = (params: unknown, observed = true) => {
    const id = `branch-${++requestId}`;
    return new Promise<ResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fleet.status timed out')), 5000);
      const receive = (data: WebSocket.RawData) => {
        const frame: ResponseFrame = JSON.parse(data.toString());
        if (frame.type !== 'res' || frame.id !== id) return;
        clearTimeout(timer);
        ws.off('message', receive);
        resolve(frame);
      };
      ws.on('message', receive);
      ws.send(
        JSON.stringify({
          type: 'req',
          id,
          ...(observed
            ? { method: 'fleet.status', params, resourceRead: { version: 1 } }
            : { method: 'auth.connect', params }),
        }),
      );
    });
  };
  const connected = await read({ clientKind: 'ui', token: credential.secret }, false);
  assert.equal(connected.ok, true, JSON.stringify(connected.error));

  const start = marker();
  await watchBranch(SLOT);
  await until(admitted, 'the first branch read');
  assert.equal(marker(), start, 'an admitted source starts without a marker move');
  assert.equal((await read({ versions: true })).ok, true);

  // A branch switch updates the projection and settles admitted, as before.
  const slotKey = { family: 'slot', slotId: SLOT } as const;
  const switched = resourceRevisions.revision(slotKey);
  execFileSync('git', ['-C', repo, 'symbolic-ref', 'HEAD', 'refs/heads/other']);
  await until(
    async () => resourceRevisions.revision(slotKey) >= switched + 2 && (await admitted()),
    'the branch switch to settle',
  );
  assert.equal(marker(), start, 'an update that settles to the same outcome moves no marker');

  // The source fails: both read shapes are refused alike, and the marker moves once.
  rmSync(head);
  await until(() => marker() > start, 'the failure to move the marker');
  const versions = await read({ versions: true });
  const full = await read({});
  assert.equal(versions.ok, false);
  assert.equal(versions.error?.code, 'RESOURCE_OBSERVATION_FAILED');
  assert.deepEqual(versions.error, full.error, 'the versions read is refused as the full read is');
  for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(marker(), start + 1, 'one marker move for the failure');

  // The source recovers: the marker moves once more and reads are admitted again.
  writeFileSync(head, 'ref: refs/heads/main\n');
  await until(() => marker() > start + 1, 'the recovery to move the marker');
  assert.equal((await read({ versions: true })).ok, true);
  for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(marker(), start + 2, 'one marker move for the recovery');
});
