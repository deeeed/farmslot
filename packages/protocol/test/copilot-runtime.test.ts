import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ChatAbortResult,
  ChatMethods,
  type ChatSendResult,
  CopilotRuntimeMethods,
  type CopilotRuntimeSession,
  type CopilotStartParams,
  type CopilotStatusResult,
  Events,
  Methods,
} from '../src/index.js';

test('Co-Pilot runtime and compatibility method names remain stable', () => {
  assert.deepEqual(CopilotRuntimeMethods, {
    status: 'copilot.status',
    configure: 'copilot.configure',
    start: 'copilot.start',
    stop: 'copilot.stop',
  });
  assert.equal(CopilotRuntimeMethods.status, Methods.COPILOT_STATUS);
  assert.equal(CopilotRuntimeMethods.configure, Methods.COPILOT_CONFIGURE);
  assert.equal(CopilotRuntimeMethods.start, Methods.COPILOT_START);
  assert.equal(CopilotRuntimeMethods.stop, Methods.COPILOT_STOP);
  assert.equal('send' in ChatMethods, false);
  assert.equal(ChatMethods.archive, 'chat.archive');
  assert.equal('abort' in ChatMethods, false);
  assert.equal(Events.COPILOT_RUNTIME_UPDATED, 'copilot.runtime.updated');
});

test('one client-neutral session shape carries lifecycle, checkout, delivery, workload, and binding', () => {
  const session: CopilotRuntimeSession = {
    runtimeId: 'gateway-copilot',
    status: 'running',
    nativeSession: { sessionId: 'singleton', executionNodeId: 'local' },
    runner: 'cursor',
    model: 'test-model',
    safetyTier: 'sandboxed',
    checkout: {
      path: '/operator/farmslot',
      branch: 'feat/copilot',
      head: 'abc123',
      dirtyFileCount: 0,
      dirtyPaths: [],
    },
    workload: {
      severity: 'normal',
      totals: {
        implementation: 0,
        review: 0,
        reviewRework: 0,
        ciFix: 0,
        fullQa: 0,
        recipe: 0,
        prepare: 0,
        devServer: 0,
        copilot: 1,
        total: 1,
      },
      hosts: [],
      policy: {
        singleton: true,
        automaticCancellation: false,
        automaticDispatch: false,
        automaticFanOut: false,
      },
    },
    lastDelivery: { id: 'delivery-1', state: 'accepted', requestedAt: 'now' },
    updatedAt: 'now',
    dangerousLaunch: {
      fingerprint: 'fingerprint',
      typedPhrase: 'ENABLE DANGEROUS CO-PILOT',
      warning: 'same-user access warning',
      checkout: '/operator/farmslot',
      branch: 'feat/copilot',
      head: 'abc123',
      dirtyFileCount: 0,
      runner: 'cursor',
      model: 'test-model',
      safetyTier: 'dangerous',
    },
  };
  const status: CopilotStatusResult = { session };
  const dangerousStart: CopilotStartParams = {
    runner: session.runner,
    model: session.model,
    safetyTier: 'dangerous',
    confirmation: {
      fingerprint: session.dangerousLaunch.fingerprint,
      typedPhrase: session.dangerousLaunch.typedPhrase,
      warningAcknowledged: true,
    },
  };
  const send: ChatSendResult = { messageId: 'message-1', delivery: session.lastDelivery };
  const abort: ChatAbortResult = { ok: true };
  assert.equal(status.session.runtimeId, 'gateway-copilot');
  assert.equal(dangerousStart.confirmation?.fingerprint, 'fingerprint');
  assert.equal(send.delivery?.state, 'accepted');
  assert.equal(abort.ok, true);
});
