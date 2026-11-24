'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const vm = require('node:vm');

const {
  LOG_BINDING,
  PAGE_MARKER,
  REQUEST_BINDING,
  pageReadyExpression,
  pageScriptSource,
} = require('../src/dapp/page-script.cjs');

const APP = 'http://localhost:9341';
const INJECTED = {
  info: {
    uuid: '00000000-0000-4000-8000-000000000001',
    name: 'Test wallet',
    icon: 'data:,',
    rdns: 'test.wallet',
  },
  isMetaMask: false,
};
// Refuses typed data whose message says it is for production.
const REFUSE = {
  reason: function productionReason(data) {
    return data?.message?.env === 'production' ? 'env=production' : null;
  },
  kind: 'refused-production',
  message: 'Refused: this run signs only for staging.',
};

// The page script in a fake window: what it logs, what it forwards to the host.
function preload({
  origin = APP,
  top = true,
  signer = 'injected',
  bindings = true,
  provider,
  refuseTypedData = null,
  injectedWallet = INJECTED,
} = {}) {
  const logged = [];
  const requests = [];
  const listeners = {};
  const window = {
    location: { pathname: '/order/ETH', origin },
    addEventListener: (event, fn) => {
      (listeners[event] ??= []).push(fn);
    },
    dispatchEvent: (event) => {
      (listeners[event.type] ?? []).forEach((fn) => fn(event));
    },
    ethereum: provider,
  };
  if (bindings) {
    window[LOG_BINDING] = (payload) => logged.push(JSON.parse(payload));
    window[REQUEST_BINDING] = (payload) => requests.push(JSON.parse(payload));
  }
  window.top = top ? window : {};
  const context = vm.createContext({
    window,
    location: window.location,
    setInterval: () => 0,
    clearInterval: () => {},
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  });
  vm.runInContext(
    pageScriptSource({ signer, appOrigin: APP, refuseTypedData, injectedWallet }),
    context,
  );
  return { window, logged, requests, context };
}

const chainOne = (calls = []) => ({
  async request({ method }) {
    calls.push(method);
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_signTypedData_v4') return '0xsig';
    return null;
  },
});

describe('page script', () => {
  it('installs only in the top frame of the exact app origin', () => {
    assert.equal(typeof preload().window.ethereum?.request, 'function');
    assert.equal(preload({ top: false }).window.ethereum, undefined);
    assert.equal(preload({ origin: 'https://evil.test' }).window.ethereum, undefined);
    assert.equal(preload({ origin: 'http://localhost:93410' }).window.ethereum, undefined);
  });

  it('logs typed-data requests with primary type, domain and active chain, without params', async () => {
    const { window, logged } = preload({ signer: 'extension', provider: chainOne() });
    const data = JSON.stringify({
      primaryType: 'Permit',
      domain: { name: 'Test', chainId: 1 },
      message: { secret: 'x' },
    });
    await window.ethereum.request({ method: 'eth_signTypedData_v4', params: ['0xabc', data] });
    await window.ethereum.request({ method: 'eth_blockNumber' });
    assert.equal(logged.length, 1);
    assert.deepEqual(
      {
        method: logged[0].method,
        primaryType: logged[0].primaryType,
        domainChainId: logged[0].domainChainId,
        activeChainId: logged[0].activeChainId,
        outcome: logged[0].outcome,
        source: logged[0].source,
      },
      {
        method: 'eth_signTypedData_v4',
        primaryType: 'Permit',
        domainChainId: 1,
        activeChainId: 1,
        outcome: 'signed',
        source: 'window.ethereum',
      },
    );
    assert.doesNotMatch(JSON.stringify(logged[0]), /secret/);
  });

  it('records a user rejection as rejected and rethrows it', async () => {
    const provider = {
      async request({ method }) {
        if (method === 'eth_chainId') return '0xa4b1';
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      },
    };
    const { window, logged } = preload({ signer: 'extension', provider });
    await assert.rejects(
      window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x1' }],
      }),
      { code: 4001 },
    );
    assert.equal(logged[0].toChainId, 1);
    assert.equal(logged[0].activeChainId, 42161);
    assert.equal(logged[0].outcome, 'rejected');
    assert.equal(logged[0].errorCode, 4001);
  });

  it('logs an error code and fixed category, never provider text', async () => {
    const marker = 'SENSITIVE-MARKER-0xdeadbeef';
    const provider = {
      async request({ method }) {
        if (method === 'eth_chainId') return '0x1';
        throw Object.assign(new Error(`signing failed for ${marker}`), {
          code: -32603,
          data: marker,
        });
      },
    };
    const { window, logged } = preload({ signer: 'extension', provider });
    await assert.rejects(
      window.ethereum.request({ method: 'personal_sign', params: ['0x00', '0x01'] }),
      new RegExp(marker),
    );
    assert.equal(logged.length, 1);
    assert.doesNotMatch(JSON.stringify(logged[0]), new RegExp(marker));
    assert.equal(logged[0].errorCategory, 'internal');
  });

  it('refuses a wallet request when the host binding is missing instead of letting it go unrecorded', async () => {
    const calls = [];
    const extension = preload({ signer: 'extension', bindings: false, provider: chainOne(calls) });
    await assert.rejects(
      extension.window.ethereum.request({ method: 'personal_sign', params: ['0x00', '0x01'] }),
      { code: 4100 },
    );
    assert.deepEqual(calls, []);
    const injected = preload({ bindings: false });
    await assert.rejects(injected.window.ethereum.request({ method: 'eth_requestAccounts' }), {
      code: 4100,
    });
  });

  for (const signer of ['extension', 'injected']) {
    it(`${signer}: typed data the policy refuses never reaches the signer`, async () => {
      const calls = [];
      const { window, logged, requests } = preload({
        signer,
        provider: chainOne(calls),
        refuseTypedData: REFUSE,
      });
      const production = JSON.stringify({
        primaryType: 'Permit',
        domain: { chainId: 1 },
        types: {},
        message: { env: 'production' },
      });
      await assert.rejects(
        window.ethereum.request({ method: 'eth_signTypedData_v4', params: ['0x01', production] }),
        { code: 4100, message: REFUSE.message },
      );
      assert.deepEqual(
        calls.filter((method) => method === 'eth_signTypedData_v4'),
        [],
      );
      assert.deepEqual(requests, []);
      assert.deepEqual(
        logged.map((entry) => [entry.kind, entry.reason, entry.outcome]),
        [['refused-production', 'env=production', 'refused']],
      );
    });
  }

  it('refuses when the refusal check throws, and leaves unparseable data to the signer', async () => {
    const calls = [];
    const throwing = {
      ...REFUSE,
      reason: function broken(data) {
        return data.message.missing.field;
      },
    };
    const { window, logged } = preload({
      signer: 'extension',
      provider: chainOne(calls),
      refuseTypedData: throwing,
    });
    const data = JSON.stringify({
      primaryType: 'Permit',
      domain: { chainId: 1 },
      types: {},
      message: {},
    });
    await assert.rejects(
      window.ethereum.request({ method: 'eth_signTypedData_v4', params: ['0x01', data] }),
      { code: 4100 },
    );
    assert.deepEqual(
      logged.map((entry) => [entry.kind, entry.reason]),
      [['refused-production', 'the refusal check threw']],
    );
    assert.equal(
      await window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: ['0x01', '{not json'],
      }),
      '0xsig',
    );
    assert.deepEqual(
      calls.filter((method) => method === 'eth_signTypedData_v4'),
      ['eth_signTypedData_v4'],
    );
  });

  it('passes typed data the policy allows, and refuses nothing without a policy', async () => {
    const staging = JSON.stringify({
      primaryType: 'Permit',
      domain: { chainId: 1 },
      types: {},
      message: { env: 'staging' },
    });
    const production = JSON.stringify({
      primaryType: 'Permit',
      domain: { chainId: 1 },
      types: {},
      message: { env: 'production' },
    });
    const guarded = preload({ signer: 'extension', provider: chainOne(), refuseTypedData: REFUSE });
    assert.equal(
      await guarded.window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: ['0x01', staging],
      }),
      '0xsig',
    );
    const open = preload({ signer: 'extension', provider: chainOne() });
    assert.equal(
      await open.window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: ['0x01', production],
      }),
      '0xsig',
    );
  });

  it('injected: forwards requests to the host, settles them through the resolver and announces the wallet', async () => {
    const announced = [];
    const page = preload({ injectedWallet: { ...INJECTED, isMetaMask: true } });
    page.window.addEventListener('eip6963:announceProvider', (event) =>
      announced.push(event.detail.info.rdns),
    );
    page.window.dispatchEvent({ type: 'eip6963:requestProvider' });
    assert.deepEqual(announced, ['test.wallet']);
    assert.equal(page.window.ethereum.isMetaMask, true);
    const pending = page.window.ethereum.request({ method: 'eth_requestAccounts' });
    // A logged method first reads the active chain, then goes to the host.
    assert.deepEqual(page.requests, [{ id: 1, method: 'eth_chainId' }]);
    page.window.__farmslotWalletResolve(1, { result: '0x1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(page.requests.at(-1), { id: 2, method: 'eth_requestAccounts' });
    page.window.__farmslotWalletResolve(2, { result: ['0xaa'] });
    assert.deepEqual(await pending, ['0xaa']);
    assert.deepEqual(
      page.logged.map((entry) => [entry.method, entry.activeChainId, entry.outcome, entry.source]),
      [['eth_requestAccounts', 1, 'approved', 'injected-strict-wallet']],
    );
    assert.equal(preload().window.ethereum.isMetaMask, undefined);
  });

  it('injected MetaMask: answers the extension streams so connect-multichain can start a session', async () => {
    const page = preload({ injectedWallet: { ...INJECTED, isMetaMask: true } });
    const store = new Map();
    page.window.localStorage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    };
    // The host's strict wallet: on chain 42161, switches on request.
    let chain = '0xa4b1';
    page.window[REQUEST_BINDING] = (payload) => {
      const { id, method, params } = JSON.parse(payload);
      page.requests.push(method);
      if (method === 'wallet_switchEthereumChain') chain = params[0].chainId;
      const result =
        {
          eth_chainId: chain,
          eth_accounts: ['0xaa'],
          eth_requestAccounts: ['0xaa'],
          personal_sign: '0xsig',
        }[method] ?? null;
      setImmediate(() => page.window.__farmslotWalletResolve(id, { result }));
    };
    const replies = [];
    page.window.postMessage = (data, origin) => {
      assert.equal(origin, APP);
      if (data.target === 'metamask-inpage') replies.push(data.data);
      else page.window.dispatchEvent({ type: 'message', origin: APP, source: page.window, data });
    };
    const ask = async (name, id, method, params) => {
      page.window.postMessage(
        {
          target: 'metamask-contentscript',
          data: { name, data: { jsonrpc: '2.0', id, method, params } },
        },
        APP,
      );
      for (let i = 0; i < 20 && !replies.some((r) => r.data.id === id); i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return JSON.parse(JSON.stringify(replies.find((r) => r.data.id === id)));
    };
    const multichain = 'metamask-multichain-provider';
    assert.deepEqual((await ask(multichain, 1, 'wallet_getSession')).data.result, {
      sessionScopes: {},
    });
    const created = await ask(multichain, 2, 'wallet_createSession', {
      optionalScopes: { 'eip155:421614': { methods: [], notifications: [], accounts: [] } },
    });
    assert.deepEqual(created.data.result.sessionScopes['eip155:421614'].accounts, [
      'eip155:421614:0xaa',
    ]);
    assert.ok(replies.some((r) => r.data.method === 'wallet_sessionChanged'));
    // A wallet call on the scope's chain goes to the host, switching chain first.
    const signed = await ask(multichain, 3, 'wallet_invokeMethod', {
      scope: 'eip155:421614',
      request: { method: 'personal_sign', params: ['0x68', '0xaa'] },
    });
    assert.equal(signed.data.result, '0xsig');
    assert.equal(chain, '0x66eee');
    // The EIP-1193 stream answers from the same provider; a reload keeps the session.
    assert.deepEqual((await ask('metamask-provider', 4, 'eth_accounts')).data.result, ['0xaa']);
    assert.equal((await ask(multichain, 5, 'wallet_bogus')).data.error.code, 4200);
    assert.deepEqual(JSON.parse(store.get('__farmslotMultichainSession')), ['eip155:421614']);
    assert.equal((await ask(multichain, 6, 'wallet_revokeSession')).data.result, true);
    assert.deepEqual((await ask(multichain, 7, 'wallet_getSession')).data.result, {
      sessionScopes: {},
    });
    // A wallet not presented as MetaMask serves no extension stream.
    const plain = preload();
    let answered = false;
    plain.window.postMessage = (data) => {
      if (data.target === 'metamask-inpage') answered = true;
      else plain.window.dispatchEvent({ type: 'message', origin: APP, source: plain.window, data });
    };
    plain.window.postMessage(
      {
        target: 'metamask-contentscript',
        data: { name: multichain, data: { id: 1, method: 'wallet_getSession' } },
      },
      APP,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answered, false);
  });

  it('marks the preload ready only when the page provider is wrapped', () => {
    const ok = preload({ signer: 'extension', provider: { request: async () => null } });
    assert.equal(ok.window[PAGE_MARKER].wrapped, 1);
    assert.equal(
      vm.runInContext(
        pageReadyExpression({ signer: 'extension', refusesTypedData: false }),
        ok.context,
      ),
      true,
    );
    assert.equal(
      vm.runInContext(
        pageReadyExpression({ signer: 'extension', refusesTypedData: true }),
        ok.context,
      ),
      false,
    );
    assert.equal(
      vm.runInContext(
        pageReadyExpression({ signer: 'injected', refusesTypedData: false }),
        ok.context,
      ),
      false,
    );
    const frozen = preload({
      signer: 'extension',
      provider: Object.freeze({ request: async () => null }),
    });
    assert.deepEqual([...frozen.window[PAGE_MARKER].wrapFailures], ['window.ethereum']);
    assert.equal(
      vm.runInContext(
        pageReadyExpression({ signer: 'extension', refusesTypedData: false }),
        frozen.context,
      ),
      false,
    );
    const guarded = preload({ refuseTypedData: REFUSE });
    assert.equal(
      vm.runInContext(
        pageReadyExpression({ signer: 'injected', refusesTypedData: true }),
        guarded.context,
      ),
      true,
    );
  });

  it('refuses an unknown signer, a policy without a reason and an injected signer without an identity', () => {
    assert.throws(() => pageScriptSource({ signer: 'other', appOrigin: APP }), /signer must be/);
    assert.throws(
      () =>
        pageScriptSource({
          signer: 'extension',
          appOrigin: APP,
          refuseTypedData: { ...REFUSE, kind: '' },
        }),
      /kind must be a non-empty string/,
    );
    assert.throws(
      () =>
        pageScriptSource({
          signer: 'extension',
          appOrigin: APP,
          refuseTypedData: { ...REFUSE, message: undefined },
        }),
      /message must be a non-empty string/,
    );
    assert.throws(
      () =>
        pageScriptSource({
          signer: 'extension',
          appOrigin: APP,
          refuseTypedData: { ...REFUSE, reason: REFUSE.reason.bind(null) },
        }),
      /bound or native function/,
    );
    const shorthand = {
      reason(data) {
        return data ? null : 'x';
      },
      kind: 'k',
      message: 'm',
    };
    assert.throws(
      () => pageScriptSource({ signer: 'extension', appOrigin: APP, refuseTypedData: shorthand }),
      /method shorthand/,
    );
    assert.throws(
      () =>
        pageScriptSource({ signer: 'extension', appOrigin: APP, refuseTypedData: { kind: 'x' } }),
      /reason must be a function/,
    );
    assert.throws(
      () => pageScriptSource({ signer: 'injected', appOrigin: APP }),
      /injectedWallet\.info/,
    );
  });
});
