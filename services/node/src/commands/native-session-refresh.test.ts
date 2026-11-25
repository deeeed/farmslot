// @farmslot:serial. Uses an owned detached host and OS process cleanup.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  setup,
  stopNativeStack,
  until,
} from '@farmslot/agent-runtime/native/durability.test-support';
import type { NativeSessionInfo } from '@farmslot/protocol';

import { NativeNodeSessions } from './native-session.js';

type Session = Pick<NativeSessionInfo, 'id' | 'state'>;

/** A node on a fixture state directory; its host's runtime is faked older in host.json only. */
async function skewedNode(t: TestContext, fields: Record<string, unknown> = {}) {
  const fixture = setup({ manualTurns: true });
  const hostRoot = path.join(fixture.cwd, 'nodes', 'fixture-node');
  // Registered before the host starts, so a failing setup still stops it.
  t.after(() => stopNativeStack({ ...fixture, root: hostRoot }));
  const node = new NativeNodeSessions('fixture-node', 'owner', fixture.cwd);
  const route = (method: string, params: Record<string, unknown>, hostRelease?: string[]) =>
    node.route({ owner: 'owner', method, params, ...(hostRelease ? { hostRelease } : {}) });
  const create = (hostRelease?: string[]) =>
    route('native.session.create', { runner: 'codex', cwd: fixture.cwd }, hostRelease) as Promise<{
      session: Session;
    }>;
  const state = async (id: string) =>
    ((await route('native.session.list', {})) as { sessions: Session[] }).sessions.find(
      (session) => session.id === id,
    )?.state;
  const hostPid = () =>
    (JSON.parse(readFileSync(path.join(hostRoot, 'host.json'), 'utf8')) as { pid: number }).pid;
  await node.prepareRuntime();
  const { session } = await create();
  await route('native.session.send', { sessionId: session.id, commandId: 'turn', text: 'first' });
  await fixture.completeTurn();
  await until(async () => (await state(session.id)) === 'idle');
  const file = path.join(hostRoot, 'host.json');
  writeFileSync(
    file,
    JSON.stringify({
      ...JSON.parse(readFileSync(file, 'utf8')),
      runtimeVersion: '0.0.0',
      ...fields,
    }),
  );
  return { session, create, state, hostPid };
}

test('a node launch with the gateway’s release list refreshes its older-runtime host', async (t) => {
  const node = await skewedNode(t);
  const before = node.hostPid();
  // Without a list the node keeps refusing, as an older gateway's launch does.
  await assert.rejects(node.create(), { code: 'NATIVE_HOST_VERSION_SKEW' });
  assert.equal(node.hostPid(), before);

  const { session } = await node.create([node.session.id]);

  assert.ok(session.id);
  assert.notEqual(node.hostPid(), before);
  assert.equal(await node.state(node.session.id), 'failed');
});

test('a node stops idle runners only on a fenced host', async (t) => {
  const node = await skewedNode(t, { supportsIdleRunnerUpgrade: undefined });
  const before = node.hostPid();
  await assert.rejects(node.create([node.session.id]), {
    message: /the host predates the idle-runner fence/,
  });
  assert.equal(node.hostPid(), before);
});
