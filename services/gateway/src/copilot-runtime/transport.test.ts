import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runWithSessionOriginator } from '../security/work-originator.js';

import { CopilotRuntimeStore } from './session-store.js';
import { FakeCopilotNative, testController } from './test-helpers.js';

test('native ensure is precommitted and attributes the configured owner and requesting person', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-native-start-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const native = new FakeCopilotNative();
  const ensure = native.ensure.bind(native);
  native.ensure = async (owner, params, requester) => {
    const saved = await new CopilotRuntimeStore(home).load();
    assert.equal(saved?.pendingNativeSessionId, params.sessionId);
    assert.equal(saved?.session.nativeSession?.sessionId, params.sessionId);
    return ensure(owner, params, requester);
  };
  const { controller } = testController({ home, checkout: home, native });
  await runWithSessionOriginator(
    {
      id: 'arthur',
      generation: 1,
      subject: { type: 'person', displayName: 'Arthur' },
      roles: [{ role: 'admin', scope: { kind: 'global' } }],
    },
    () => controller.start(),
  );
  assert.equal(native.requests[0].owner, 'farm');
  assert.deepEqual(native.requests[0].requester, { principalId: 'arthur', principalGeneration: 1 });
  assert.equal(native.requests[0].params.approvalMode, 'ask');
  assert.equal(native.requests[0].params.cwd, home);
  await controller.stop();
});

test('unconfirmed bootstrap keeps one deduplicated command and never claims acceptance', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-native-unknown-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const native = new FakeCopilotNative();
  native.accept = false;
  const { controller } = testController({ home, checkout: home, native });
  await assert.rejects(controller.start(), /acceptance is unconfirmed/);
  const first = controller.currentSession()?.nativeSession?.sessionId;
  await assert.rejects(controller.start(), /acceptance is unconfirmed/);
  assert.equal(controller.currentSession()?.nativeSession?.sessionId, first);
  assert.equal(native.launches, 1);
  assert.equal(native.sends.size, 1);
  assert.equal(controller.currentSession()?.lastDelivery.state, 'deferred');
  await controller.stop();
});

test('dangerous starts retain exact confirmation and use native bypass only after confirmation', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-native-dangerous-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { controller, native } = testController({ home, checkout: home });
  const { session } = await controller.status();
  await assert.rejects(controller.start({ safetyTier: 'dangerous' }), /typed confirmation/);
  assert.equal(native.launches, 0);
  await controller.start({
    safetyTier: 'dangerous',
    confirmation: {
      fingerprint: session.dangerousLaunch.fingerprint,
      typedPhrase: session.dangerousLaunch.typedPhrase,
      warningAcknowledged: true,
    },
  });
  assert.equal(native.requests[0].params.approvalMode, 'bypass');
  await controller.stop();
});

test(
  'bootstrap waits for a durable native acceptance receipt after submission',
  { timeout: 10_000 },
  async (t) => {
    const home = await mkdtemp(path.join(tmpdir(), 'copilot-deferred-ack-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const native = new FakeCopilotNative();
    let sent!: () => void;
    const submitted = new Promise<void>((resolve) => {
      sent = resolve;
    });
    native.send = async (owner, id, commandId) => {
      await native.inspect(owner, id);
      const pending = { commandId, submitted: true, accepted: false, state: 'pending' as const };
      native.sends.set(commandId, pending);
      native.publish();
      sent();
      return pending;
    };
    const { controller } = testController({ home, checkout: home, native });
    let settled = false;
    const starting = controller.start().then((value) => {
      settled = true;
      return value;
    });
    // The old implementation rejects at this point despite a later valid acknowledgment.
    const captured = starting.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await submitted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    const command = [...native.sends.values()][0];
    native.sends.set(command.commandId, { ...command, accepted: true, state: 'accepted' });
    native.publish();
    const result = await captured;
    assert.ok(
      'value' in result,
      'Submitted native turns must be allowed to acknowledge asynchronously',
    );
    if ('value' in result) assert.equal(result.value.session.status, 'running');
    assert.equal(native.sends.size, 1);
    await controller.stop();
  },
);

test('owner reassignment cannot replace a live singleton and confirmed Stop permits a new owner', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-owner-fence-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let owner = 'farm';
  const { controller, native } = testController({ home, checkout: home, owner: () => owner });
  const started = await controller.start();
  const first = started.session.nativeSession!.sessionId;
  owner = 'replacement';
  await assert.rejects(controller.start(), /owner|original/i);
  assert.equal(native.launches, 1);
  assert.equal(native.sessions.get(first)?.state, 'idle');
  owner = 'farm';
  await controller.stop();
  owner = 'replacement';
  const replacement = await controller.start();
  assert.notEqual(replacement.session.nativeSession?.sessionId, first);
  assert.equal(native.launches, 2);
  await controller.stop();
});

test('a confirmed terminal reservation does not trap the next explicit Start on its old UUID', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-terminal-reservation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const native = new FakeCopilotNative();
  native.beforeSend = async () => {
    throw new Error('fixture bootstrap send failure');
  };
  const { controller } = testController({ home, checkout: home, native });
  await assert.rejects(controller.start(), /bootstrap send failure/);
  const old = controller.currentSession()!.nativeSession!.sessionId;
  const info = native.sessions.get(old)!;
  info.state = 'failed';
  info.processStopped = true;
  native.beforeSend = undefined;
  const fresh = await controller.start();
  assert.notEqual(fresh.session.nativeSession?.sessionId, old);
  assert.equal(fresh.session.status, 'running');
  await controller.stop();
});
