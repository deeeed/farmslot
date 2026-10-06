'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { LOG_BINDING, REQUEST_BINDING, RESOLVE_FN } = require('../src/dapp/page-script.cjs');
const {
  PENDING_CALL_TTL_MS,
  createWalletRequestBinding,
} = require('../src/dapp/wallet-requests.cjs');

const APP = 'http://localhost:9341';

// A CDP connection the test drives: emit() delivers an event, sends are kept.
function fakeClient() {
  const handlers = new Map();
  const sent = [];
  return {
    sent,
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(handler);
    },
    async send(method, params, sessionId) {
      sent.push({ method, params, sessionId });
      return {};
    },
    emit(method, params, sessionId) {
      for (const handler of handlers.get(method) ?? []) handler(params, sessionId);
    },
  };
}

function setup({ signer = 'injected', wallet, refuseTypedData = null } = {}) {
  const client = fakeClient();
  const records = [];
  const said = [];
  const binding = createWalletRequestBinding({
    client,
    appOrigin: APP,
    signer,
    wallet,
    refuseTypedData,
    record: (entry) => records.push(entry),
    say: (message) => said.push(message),
  });
  const context = (id, { origin = APP, frameId = 'TAB', isDefault = true } = {}) =>
    client.emit(
      'Runtime.executionContextCreated',
      { context: { id, origin, auxData: { frameId, isDefault } } },
      'S1',
    );
  const call = (name, payload, executionContextId = 1) =>
    client.emit(
      'Runtime.bindingCalled',
      { name, payload: JSON.stringify(payload), executionContextId },
      'S1',
    );
  const resolutions = () =>
    client.sent
      .filter((send) => send.method === 'Runtime.evaluate')
      .map((send) => send.params.expression);
  return { binding, client, records, said, context, call, resolutions };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('wallet request binding', () => {
  it('adds the log binding, and the request binding for the injected signer', async () => {
    const injected = setup();
    await injected.binding.install('S1', 'TAB');
    assert.deepEqual(
      injected.client.sent.map((send) => send.params.name),
      [LOG_BINDING, REQUEST_BINDING],
    );
    const extension = setup({ signer: 'extension' });
    await extension.binding.install('S1', 'TAB');
    assert.deepEqual(
      extension.client.sent.map((send) => send.params.name),
      [LOG_BINDING],
    );
  });

  it('records a log entry from the app top frame and answers its requests with the wallet', async () => {
    const wallet = { request: async ({ method }) => (method === 'eth_accounts' ? ['0xaa'] : null) };
    const { binding, records, context, call, resolutions } = setup({ wallet });
    await binding.install('S1', 'TAB');
    binding.commit('S1', `${APP}/order/ETH`, 'L1');
    context(1);
    call(LOG_BINDING, { kind: 'request', method: 'eth_requestAccounts', outcome: 'approved' });
    call(REQUEST_BINDING, { id: 7, method: 'eth_accounts', params: [] });
    await tick();
    assert.deepEqual(records, [
      { kind: 'request', method: 'eth_requestAccounts', outcome: 'approved' },
    ]);
    assert.deepEqual(resolutions(), [`window.${RESOLVE_FN}(7, {"result":["0xaa"]})`]);
  });

  it('refuses an iframe and a blank popup with 4100 and records them outside the app frame', async () => {
    const { binding, records, context, call, resolutions } = setup({
      wallet: { request: async () => null },
    });
    await binding.install('S1', 'TAB');
    binding.commit('S1', `${APP}/`, 'L1');
    context(1);
    context(2, { frameId: 'IFRAME', isDefault: true, origin: 'https://evil.test' });
    call(REQUEST_BINDING, { id: 1, method: 'eth_accounts' }, 2);
    binding.commit('S1', 'about:blank', 'L2');
    context(3);
    call(LOG_BINDING, { kind: 'request', method: 'personal_sign' }, 3);
    await tick();
    assert.deepEqual(
      records.map((entry) => [entry.kind, entry.binding, entry.origin, entry.document]),
      [
        ['outside-app-frame', 'request', 'https://evil.test', null],
        ['outside-app-frame', 'log', APP, 'about://blank'],
      ],
    );
    assert.equal(resolutions().length, 1);
    assert.match(resolutions()[0], /Wallet requests are accepted only from the app top frame\./);
    assert.match(resolutions()[0], /"code":4100/);
  });

  it('judges a call made before its document commits against that document, not the previous commit', async () => {
    const { binding, records, context, call } = setup({ signer: 'extension' });
    await binding.install('S1', 'TAB');
    binding.commit('S1', `${APP}/`, 'L1');
    context(1);
    // The next document's context exists, and calls, before its commit (a popup).
    context(2);
    call(LOG_BINDING, { kind: 'request', method: 'eth_requestAccounts' }, 2);
    binding.commit('S1', 'about:blank', 'L2');
    await tick();
    assert.deepEqual(
      records.map((entry) => entry.kind),
      ['outside-app-frame'],
    );
  });

  it('applies a commit reported twice (frame tree and frameNavigated) once', async () => {
    const { binding, records, context, call } = setup({ signer: 'extension' });
    await binding.install('S1', 'TAB');
    binding.commit('S1', `${APP}/`, 'L1');
    context(1);
    binding.commit('S1', `${APP}/`, 'L1');
    context(2);
    binding.commit('S1', `${APP}/next`, 'L2');
    call(LOG_BINDING, { kind: 'request', method: 'eth_requestAccounts' }, 2);
    await tick();
    assert.deepEqual(
      records.map((entry) => entry.method),
      ['eth_requestAccounts'],
    );
  });

  it('refuses typed data the policy names before the wallet signs', async () => {
    const signed = [];
    const refuseTypedData = {
      reason: (data) => (data?.message?.env === 'production' ? 'env=production' : null),
      kind: 'refused-production',
      message: 'Refused: staging only.',
    };
    const wallet = { request: async ({ method }) => signed.push(method) };
    const { binding, records, context, call, resolutions } = setup({ wallet, refuseTypedData });
    await binding.install('S1', 'TAB');
    binding.commit('S1', `${APP}/`, 'L1');
    context(1);
    call(REQUEST_BINDING, {
      id: 3,
      method: 'eth_signTypedData_v4',
      params: ['0x01', JSON.stringify({ message: { env: 'production' } })],
    });
    await tick();
    assert.deepEqual(signed, []);
    assert.deepEqual(
      records.map((entry) => [entry.kind, entry.reason, entry.layer]),
      [['refused-production', 'env=production', 'wallet-host']],
    );
    assert.match(resolutions()[0], /Refused: staging only\./);
  });

  it('refuses when the refusal check throws, and refuses a policy it cannot apply', async () => {
    const signed = [];
    const refuseTypedData = {
      reason: () => {
        throw new Error('boom');
      },
      kind: 'refused-x',
      message: 'Refused.',
    };
    const { binding, records, context, call } = setup({
      wallet: { request: async ({ method }) => signed.push(method) },
      refuseTypedData,
    });
    await binding.install('S1', 'TAB');
    binding.commit('S1', `${APP}/`, 'L1');
    context(1);
    call(REQUEST_BINDING, { id: 5, method: 'eth_signTypedData_v4', params: ['0x01', '{}'] });
    await tick();
    assert.deepEqual(signed, []);
    assert.deepEqual(
      records.map((entry) => [entry.kind, entry.reason]),
      [['refused-x', 'the refusal check threw']],
    );
    assert.throws(
      () => setup({ refuseTypedData: { reason: () => null, kind: 'k' } }),
      /message must be a non-empty string/,
    );
  });

  it('holds an early call until its context is known, and records it unattributed when the tab detaches first', async () => {
    const { binding, records, said, context, call } = setup({ signer: 'extension' });
    await binding.install('S1', 'TAB');
    call(LOG_BINDING, { kind: 'request', method: 'eth_requestAccounts' }, 1);
    assert.deepEqual(records, []);
    binding.commit('S1', `${APP}/`, 'L1');
    context(1);
    await tick();
    assert.deepEqual(
      records.map((entry) => entry.method),
      ['eth_requestAccounts'],
    );
    call(REQUEST_BINDING, { id: 9, method: 'eth_accounts' }, 5);
    binding.detach('S1');
    assert.deepEqual(records.at(-1), {
      kind: 'unattributed',
      t: records.at(-1).t,
      binding: 'request',
      method: 'eth_accounts',
      loggedKind: null,
      reason: 'its tab detached first',
    });
    assert.match(said.at(-1), /could not be judged \(its tab detached first\)/);
  });

  it('records a call whose document is never attributed and refuses it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { binding, records, call, resolutions } = setup({
      wallet: { request: async () => null },
    });
    binding.install('S1', 'TAB');
    call(REQUEST_BINDING, { id: 4, method: 'eth_accounts' }, 8);
    t.mock.timers.tick(PENDING_CALL_TTL_MS + 50);
    assert.deepEqual(
      records.map((entry) => [entry.kind, entry.reason]),
      [['unattributed', 'its document was never attributed']],
    );
    assert.match(resolutions()[0], /could not attribute/);
  });
});
