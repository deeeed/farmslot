import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { assertNativeIntegrationRead } from './prove-native-planning-integration.mjs';

const method = 'copilot.status';
function evidence() {
  const initial = { startedAt: 100, workspaceKey: 'reader-A', connectionProfileId: 'private-A' };
  const data = { session: { status: 'stopped', effort: 'high', autostart: false } };
  const resourceState = {
    epoch: 'current-gateway',
    dependencies: [{ key: { family: 'copilot-runtime' }, revision: 7 }],
  };
  const state = {
    ...initial,
    domainObservations: {
      [method]: {
        id: `${method}:{}`,
        status: 'ready',
        hasData: true,
        persisted: false,
        data,
        resourceState,
      },
    },
  };
  const counts = {
    lastObservedReads: {
      [method]: {
        completedAt: 120,
        resourceState: structuredClone(resourceState),
        payloadSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      },
    },
  };
  return { initial, state, counts };
}

test('native memory evidence binds actual current payload, resource stamp and runtime', () => {
  const { initial, state, counts } = evidence();
  assertNativeIntegrationRead(initial, state, counts, method);
});

for (const key of ['startedAt', 'workspaceKey', 'connectionProfileId']) {
  test(`refuses another native ${key}`, () => {
    const { initial, state, counts } = evidence();
    state[key] = key === 'startedAt' ? 101 : 'foreign';
    assert.throws(() => assertNativeIntegrationRead(initial, state, counts, method));
  });
}

test('a correct rendered label cannot excuse stale, foreign or modified read evidence', () => {
  for (const change of [
    (e) => {
      e.counts.lastObservedReads[method].completedAt = 99;
    },
    (e) => {
      e.counts.lastObservedReads[method].resourceState.epoch = 'retired-gateway';
    },
    (e) => {
      e.state.domainObservations[method].data.session.effort = 'low';
    },
    (e) => {
      e.state.domainObservations[method].status = 'error';
    },
    (e) => {
      e.state.domainObservations[method].persisted = true;
    },
  ]) {
    const e = evidence();
    change(e);
    assert.throws(() => assertNativeIntegrationRead(e.initial, e.state, e.counts, method));
  }
});
