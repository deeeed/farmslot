// The web-dapp adapter: runtime resolution, launch helpers, readiness read from
// the venue policy, and the venue policy binding. Ported from mm-harness's
// web-dapp-adapter tests; the action tests (page selection, ui.navigate, input
// read-back, the manifest) stay with the actions.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  accountName,
  appPort,
  bindWebDappPolicy,
  chromeForTestingCandidates,
  createWebDappAdapter,
  DEV_SERVER_PID_FILE,
  devServerTestnetDiagnostic,
  LAUNCH_SERVICES,
  parseLaunchArgs,
  resolveBrowser,
  resolveSigner,
  SPAWN,
  webDappPolicy,
  webDappReadiness,
} from '../src/web-dapp/index.mjs';

import { policy } from './fixtures/web-dapp-policy.mjs';

const require = createRequire(import.meta.url);
const { assertMatch, contains } = require('./fixtures/match.cjs');

process.env.RECIPE_WEB_DAPP_POLICY = policy.module;
const TEST_SIGNER_MODULE = fileURLToPath(
  new URL('./fixtures/web-dapp-test-signer.mjs', import.meta.url),
);

describe('web-dapp adapter shape', () => {
  it('never detects a checkout: an app is a web-dapp through the adapter that extends it', () => {
    const adapter = createWebDappAdapter({ hooks: {} });
    assert.equal(adapter.detect, undefined);
    assert.equal(adapter.id, 'web-dapp');
    assert.equal(adapter.sdkVersion, 1);
    assert.equal(createWebDappAdapter({ id: 'venue' }).id, 'venue');
  });

  it('takes the signer module as the one source of the signer hooks', async () => {
    assert.throws(
      () => createWebDappAdapter({ signers: { extension: {} } }),
      /pass `signerModule`/,
    );
    const target = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-signer-module-'));
    const withModule = createWebDappAdapter({ signerModule: TEST_SIGNER_MODULE });
    const checks = await withModule.readiness.liveChecks(target);
    assertMatch(
      checks.find((entry) => entry.id.endsWith('-test-signer')),
      { status: 'pass', required: true },
    );
    // No module: the default signer is injected, which needs none.
    const without = await createWebDappAdapter().readiness.liveChecks(target);
    assert.equal(
      without.some((entry) => /-(test-signer|extension-signer)$/u.test(entry.id)),
      false,
    );
  });

  it('takes the host actions as a hook and refuses to invent a manifest', () => {
    const actions = {
      manifestPath: () => '/host/web-dapp.json',
      semantic: [],
      cdpTarget: { transport: 'chrome-cdp', probePath: 'json/version' },
    };
    assert.equal(createWebDappAdapter({ hooks: { actions } }).actions, actions);
    assert.throws(() => createWebDappAdapter().actions.manifestPath(), /ships no action manifest/);
  });

  it('merges host diagnostics and readiness over the generic members, and replaces the rest', () => {
    const console = {
      start: async () => {},
      files: () => ({}),
      cdpPort: () => undefined,
      verifyControl: async () => ({ ok: true, detail: '' }),
    };
    const adapter = createWebDappAdapter({
      hooks: {
        diagnostics: { console },
        readiness: { captureProviders: ['cdp', 'extra'] },
        harness: { restart: 'host launch' },
        reload: async () => 0,
      },
    });
    assert.equal(adapter.diagnostics.console, console);
    assert.equal(typeof adapter.diagnostics.requestLog.findings, 'function');
    assert.deepEqual(adapter.readiness.captureProviders, ['cdp', 'extra']);
    assert.equal(typeof adapter.readiness.liveChecks, 'function');
    assert.equal(adapter.harness.restart, 'host launch');
    assert.equal(typeof adapter.harness.install.entry, 'string');
    assert.equal(typeof adapter.reload, 'function');
  });
});

describe('web-dapp runtime resolution', () => {
  it('resolves ports, signer and account names', () => {
    assert.equal(appPort({ node: {} }, { TERMINAL_APP_PORT: '9341' }), 9341);
    assert.equal(appPort({ node: {} }, { WATCHER_PORT: '9342' }), 9342);
    assert.throws(() => appPort({ node: {} }, {}), /dev-server port/);
    // No signer given: extension only when a signer module is configured.
    const { RECIPE_WEB_DAPP_SIGNER_MODULE: saved } = process.env;
    try {
      delete process.env.RECIPE_WEB_DAPP_SIGNER_MODULE;
      assert.equal(resolveSigner(undefined), 'injected');
      process.env.RECIPE_WEB_DAPP_SIGNER_MODULE = '/hosts/signer.mjs';
      assert.equal(resolveSigner(undefined), 'extension');
    } finally {
      if (saved === undefined) delete process.env.RECIPE_WEB_DAPP_SIGNER_MODULE;
      else process.env.RECIPE_WEB_DAPP_SIGNER_MODULE = saved;
    }
    assert.equal(resolveSigner('extension'), 'extension');
    assert.throws(() => resolveSigner('ledger'), /extension \| injected/);
    assert.equal(accountName({ node: { account: 'Trading' } }), 'Trading');
    assert.equal(
      accountName(
        { node: { account: '0x8Dc623E964475D4d669da601Fd15ea9125469003' } },
        { account: { name: 'dev1' } },
      ),
      'dev1',
    );
  });
});

describe('web-dapp launch helpers', () => {
  it('parses launch flags and requires ports', () => {
    assertMatch(
      parseLaunchArgs([
        '--target',
        '/t',
        '--cdp-port',
        '9541',
        '--app-port',
        '9341',
        '--signer',
        'injected',
        '--fresh-profile',
      ]),
      {
        target: '/t',
        'cdp-port': '9541',
        signer: 'injected',
        'fresh-profile': true,
      },
    );
    assert.throws(() => parseLaunchArgs(['--target', '/t']), /--cdp-port/);
  });

  it('exports the launch methods a signer branches on', () => {
    assert.equal(LAUNCH_SERVICES, 'launch-services');
    assert.equal(SPAWN, 'spawn');
  });

  it('defaults to the extension signer only when a signer module is configured', () => {
    const base = ['--target', '/t', '--cdp-port', '9541', '--app-port', '9341'];
    assert.equal(parseLaunchArgs(base, {}).signer, 'injected');
    assert.equal(
      parseLaunchArgs(base, { RECIPE_WEB_DAPP_SIGNER_MODULE: '/m.mjs' }).signer,
      'extension',
    );
    assert.equal(parseLaunchArgs([...base, '--signer-module', '/m.mjs'], {}).signer, 'extension');
    assert.equal(
      parseLaunchArgs([...base, '--signer', 'injected'], {
        RECIPE_WEB_DAPP_SIGNER_MODULE: '/m.mjs',
      }).signer,
      'injected',
    );
  });

  it('accepts the signer module flag the leaves pass on', () => {
    assertMatch(
      parseLaunchArgs([
        '--target',
        '/t',
        '--cdp-port',
        '9541',
        '--app-port',
        '9341',
        '--signer-module',
        '/host/signers.mjs',
      ]),
      {
        'signer-module': '/host/signers.mjs',
      },
    );
  });

  it('uses the explicit override, else the first installed Chrome for Testing, else explains', async () => {
    await assert.rejects(
      resolveBrowser({ TERMINAL_CHROME_BIN: '/does/not/exist' }),
      /does not exist/,
    );
    const self = process.execPath;
    assertMatch(await resolveBrowser({ TERMINAL_CHROME_BIN: self }, []), {
      bin: self,
      source: 'TERMINAL_CHROME_BIN',
    });
    assertMatch(await resolveBrowser({}, ['/does/not/exist', self]), {
      bin: self,
      source: 'chrome-for-testing',
    });
    await assert.rejects(
      resolveBrowser({}, ['/does/not/exist']),
      /Chrome for Testing is not installed/,
    );
    assert.deepEqual(chromeForTestingCandidates('/nowhere', 'darwin', 'arm64'), []);
    assert.deepEqual(chromeForTestingCandidates('/nowhere', 'linux', 'x64'), []);
  });
});

describe('injected strict wallet with a real fixture signer', () => {
  it('signs typed data and a message with a viem account, recoverable to its address', async (t) => {
    let viem;
    try {
      viem = { accounts: require('viem/accounts'), core: require('viem') };
    } catch {
      t.skip('viem is not installed');
      return;
    }
    const { createStrictWallet } = require('../src/dapp/index.cjs');
    const { privateKeyToAccount } = viem.accounts;
    const { verifyMessage, verifyTypedData } = viem.core;
    // Public, well-known test key (anvil #0); never a funded fixture.
    const account = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const wallet = createStrictWallet({ account, chainId: 42161 });
    const typed = {
      domain: {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: 42161,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: {
        EIP712Domain: [],
        'HyperliquidTransaction:ApproveAgent': [
          { name: 'agentName', type: 'string' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      primaryType: 'HyperliquidTransaction:ApproveAgent',
      message: { agentName: 'mm-terminal', nonce: 1 },
    };
    const signature = await wallet.request({
      method: 'eth_signTypedData_v4',
      params: [account.address, JSON.stringify(typed)],
    });
    // The wallet signs without the EIP712Domain entry; verify the same way.
    const { EIP712Domain: _domain, ...types } = typed.types;
    assert.equal(
      await verifyTypedData({
        address: account.address,
        domain: typed.domain,
        types,
        primaryType: typed.primaryType,
        message: { agentName: 'mm-terminal', nonce: 1n },
        signature,
      }),
      true,
    );
    const personal = await wallet.request({
      method: 'personal_sign',
      params: ['0x68656c6c6f', account.address],
    });
    assert.equal(
      await verifyMessage({
        address: account.address,
        message: { raw: '0x68656c6c6f' },
        signature: personal,
      }),
      true,
    );
  });
});

describe('web-dapp readiness reads the venue from its policy', () => {
  it('checks the policy dependencies, start page and testnet variable, not hardcoded ones', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'terminal-policy-'));
    await mkdir(path.join(target, 'node_modules/venue-sdk'), { recursive: true });
    await writeFile(path.join(target, 'node_modules/venue-sdk/package.json'), '{}');
    const paths = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url);
      response.statusCode = request.url === '/start' ? 200 : 404;
      response.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const stubPolicy = {
        checkout: { matches: () => true, label: 'a stub app checkout', name: 'Stub' },
        dependencies: ['venue-sdk', 'venue-ui'],
        startPath: '/start',
        testnetVariable: 'VENUE_TESTNET',
      };
      const report = await webDappReadiness({
        policy: stubPolicy,
        target,
        appPort: server.address().port,
        env: {},
      });
      const check = (id) => report.checks.find((entry) => entry.id === id);
      assertMatch(check('checkout'), { status: 'pass', detail: 'a stub app checkout' });
      assertMatch(check('dependencies'), {
        status: 'fail',
        detail: 'missing: venue-ui (run npm ci on Node 22)',
      });
      assertMatch(check('app-dev-server'), { status: 'pass', detail: contains('/start -> 200') });
      assert.deepEqual(paths, ['/start']);
    } finally {
      server.close();
    }
  });

  it('judges the dev server by the policy testnet variable', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'terminal-policy-dev-'));
    await mkdir(path.join(target, path.dirname(DEV_SERVER_PID_FILE)), { recursive: true });
    await writeFile(path.join(target, DEV_SERVER_PID_FILE), `${process.pid}\n`);
    // One `next dev` process serving the app port from the checkout, with VENUE_TESTNET=true.
    const probe = {
      listeners: () => [process.pid],
      parents: () => new Map(),
      cwd: () => target,
      procArgs: () => ({ argv: ['node', 'next', 'dev'], env: ['VENUE_TESTNET=true'] }),
    };
    assertMatch(
      devServerTestnetDiagnostic(target, { appPort: 9341, variable: 'VENUE_TESTNET', probe }),
      { known: true, forced: true },
    );
    assertMatch(
      devServerTestnetDiagnostic(target, { appPort: 9341, variable: 'OTHER_TESTNET', probe }),
      {
        known: true,
        forced: false,
        detail: contains('OTHER_TESTNET=<unset>'),
      },
    );
  });

  it('hands a signer=extension run to the extension signer hook, and fails it when there is none', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'terminal-signer-ready-'));
    const stubPolicy = {
      checkout: { matches: () => true, label: 'stub', name: 'Stub' },
      dependencies: [],
      startPath: '/',
      testnetVariable: 'VENUE_TESTNET',
    };
    const none = await webDappReadiness({
      policy: stubPolicy,
      target,
      env: {},
      signer: 'extension',
    });
    assertMatch(
      none.checks.find((entry) => entry.id === 'extension-signer'),
      { status: 'fail', required: true },
    );
    assert.ok(none.failed.includes('extension-signer'));
    const calls = [];
    const signers = {
      extension: {
        readinessChecks: async (input) => {
          calls.push(input);
          return [{ id: 'test-extension', status: 'pass', required: input.required, detail: 'ok' }];
        },
      },
    };
    const hooked = await webDappReadiness({
      policy: stubPolicy,
      target,
      env: {},
      signer: 'extension',
      signers,
    });
    assertMatch(
      hooked.checks.find((entry) => entry.id === 'test-extension'),
      { status: 'pass', required: true },
    );
    assert.equal(
      hooked.checks.some((entry) => entry.id === 'extension-signer'),
      false,
    );
    await webDappReadiness({ policy: stubPolicy, target, env: {}, signer: 'injected', signers });
    assertMatch(
      calls.map((call) => call.required),
      [true, false],
    );
  });
});

describe('web-dapp venue policy binding', () => {
  it('binds the policy of an adapter that extends web-dapp, and only that', () => {
    const saved = process.env.RECIPE_WEB_DAPP_POLICY;
    try {
      delete process.env.RECIPE_WEB_DAPP_POLICY;
      const other = { id: 'echo', extends: 'core', policy: { module: '/elsewhere.mjs' } };
      assert.equal(bindWebDappPolicy(other), other);
      assert.equal(process.env.RECIPE_WEB_DAPP_POLICY, undefined);
      const terminal = { id: 'terminal', extends: 'web-dapp', policy };
      assert.equal(bindWebDappPolicy(terminal), terminal);
      assert.equal(process.env.RECIPE_WEB_DAPP_POLICY, policy.module);
    } finally {
      process.env.RECIPE_WEB_DAPP_POLICY = saved;
    }
  });

  it('refuses to run without a policy, while doctor reports it', async () => {
    const adapter = createWebDappAdapter({ hooks: {} });
    const saved = process.env.RECIPE_WEB_DAPP_POLICY;
    try {
      delete process.env.RECIPE_WEB_DAPP_POLICY;
      assert.throws(() => webDappPolicy(), /web-dapp needs a venue policy/);
      assertMatch(await adapter.runtimeStatus('/nowhere'), {
        decision: 'blocked',
        reasonCode: 'web-dapp-venue-policy',
      });
      assertMatch(await adapter.readiness.liveChecks('/nowhere'), [
        { id: 'web-dapp-venue-policy', status: 'fail', required: true },
      ]);
    } finally {
      process.env.RECIPE_WEB_DAPP_POLICY = saved;
    }
  });

  it('refuses a policy that misses a member or targets another contract version', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'web-dapp-policy-'));
    const write = (name, body) => {
      const file = path.join(dir, name);
      writeFileSync(file, `export const policy = ${body};\n`);
      return file;
    };
    const { policyVersion, signatureLog, ...rest } = policy;
    const members = (extra) =>
      `{ ...JSON.parse(${JSON.stringify(JSON.stringify(rest))}), venueHosts() { return { blocked: [], served: [] }; }, pagePath() { return '/'; }, checkout: { ...JSON.parse(${JSON.stringify(JSON.stringify(rest.checkout))}), matches() { return true; } }, refuseTypedData: { ...JSON.parse(${JSON.stringify(JSON.stringify(rest.refuseTypedData))}), reason() { return null; } }, ${extra} }`;
    const noLog = write('no-log.mjs', members(`policyVersion: ${policyVersion}`));
    const oldVersion = write('v0.mjs', members('policyVersion: 0, signatureLog: {}'));
    assert.throws(
      () => webDappPolicy({ RECIPE_WEB_DAPP_POLICY: noLog }),
      /no-log\.mjs: signatureLog must be an object\./,
    );
    assert.throws(
      () => webDappPolicy({ RECIPE_WEB_DAPP_POLICY: oldVersion }),
      /policyVersion is 0, this web-dapp reads 1/,
    );
    const emptyLog = write(
      'empty-log.mjs',
      members(`policyVersion: ${policyVersion}, signatureLog: {}`),
    );
    assert.throws(
      () => webDappPolicy({ RECIPE_WEB_DAPP_POLICY: emptyLog }),
      /signatureLog\.typedDataClasses must be an object; signatureLog\.forbiddenEntries must be an object/,
    );
    assert.deepEqual(
      Object.keys(webDappPolicy({ RECIPE_WEB_DAPP_POLICY: policy.module }).signatureLog),
      Object.keys(signatureLog),
    );
  });
});

describe('injected strict wallet identity', () => {
  it('is generic unless the signer module names one', async () => {
    const { injectedWalletIdentity, GENERIC_INJECTED_IDENTITY } =
      await import('../src/web-dapp/lib/signers.mjs');
    assert.equal(injectedWalletIdentity({}), GENERIC_INJECTED_IDENTITY);
    assert.equal(GENERIC_INJECTED_IDENTITY.isMetaMask, false);
    assert.equal(GENERIC_INJECTED_IDENTITY.info.rdns, 'io.farmslot.strict-wallet');
    const metamask = {
      info: { uuid: 'u', name: 'MetaMask (strict test wallet)', icon: '', rdns: 'io.metamask' },
      isMetaMask: true,
    };
    assert.equal(injectedWalletIdentity({ injected: { identity: metamask } }), metamask);
    assert.throws(
      () => injectedWalletIdentity({ injected: { identity: { info: { name: 'x' } } } }),
      /injected\.identity needs info\.uuid, info\.name and info\.rdns/u,
    );
  });
});
