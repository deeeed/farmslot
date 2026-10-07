// The test-dapp plugin fixture (test/fixtures/web-dapp-test-plugin): a plugin
// library whose adapter extends web-dapp with a venue policy that holds
// test-dapp-multichain to testnet and local hosts. It uses Node built-ins only,
// passes the policy fence, and loads through web-dapp's policy contract.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { libraryAdapterFiles } from '@farmslot/recipe-runner';

import {
  bindWebDappPolicy,
  fencePolicy,
  hostResolverRules,
  isBlockedUrl,
  webDappPolicy,
} from '../src/web-dapp/index.mjs';

const require = createRequire(import.meta.url);
const { assertMatch } = require('./fixtures/match.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, 'fixtures/web-dapp-test-plugin');
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'recipe-library.json'), 'utf8'));
const TESTNET_OR_LOCAL = /(^|[.-])(sepolia|testnet|localhost)([.-]|$)|^127\./u;

async function adapter() {
  const declared = manifest.adapters['test-dapp'];
  return (await import(pathToFileURL(path.join(PLUGIN, declared.module)).href))[declared.export];
}

describe('web-dapp test plugin fixture', () => {
  it('declares test-dapp as an adapter that extends web-dapp', async () => {
    assertMatch(manifest.adapters['test-dapp'], { extends: 'web-dapp', export: 'testDappAdapter' });
    assertMatch(await adapter(), { id: 'test-dapp', sdkVersion: 1, extends: 'web-dapp' });
  });

  it('loads through web-dapp policy contract, bound the way a host binds it', async () => {
    const saved = process.env.RECIPE_WEB_DAPP_POLICY;
    try {
      delete process.env.RECIPE_WEB_DAPP_POLICY;
      const bound = bindWebDappPolicy(await adapter());
      assert.equal(process.env.RECIPE_WEB_DAPP_POLICY, bound.policy.module);
      const policy = webDappPolicy();
      assertMatch(policy, { adapterId: 'test-dapp', policyVersion: 1, startPath: '/' });
      assert.equal(policy.pagePath({}), '/');
      assert.throws(() => policy.pagePath({ page: 'order' }), /page must be home/);
      assert.equal(policy.checkout.matches(PLUGIN), false);
    } finally {
      if (saved === undefined) delete process.env.RECIPE_WEB_DAPP_POLICY;
      else process.env.RECIPE_WEB_DAPP_POLICY = saved;
    }
  });

  it('blocks only mainnet endpoints and serves only testnet or local hosts', async () => {
    const { policy } = await adapter();
    const { blocked, served } = policy.venueHosts(PLUGIN);
    assert.ok(blocked.length > 0);
    for (const host of served) assert.match(host, TESTNET_OR_LOCAL, host);
    for (const host of blocked) assert.doesNotMatch(host, TESTNET_OR_LOCAL, host);
    assert.equal(blocked.includes(policy.probe.host), true);
    assert.equal(
      policy.linkHosts.some((host) => blocked.includes(host) || served.includes(host)),
      false,
    );
    assert.equal(isBlockedUrl(`https://${blocked[0]}/v3/key`, blocked), true);
    assert.equal(isBlockedUrl(`https://${served[0]}/v3/key`, blocked), false);
    assert.match(hostResolverRules(blocked), /^--host-resolver-rules=MAP /u);
    assert.equal(policy.startChain, 11155111);
  });

  it('refuses typed data signed for mainnet and nothing else', async () => {
    const { policy } = await adapter();
    assert.match(policy.refuseTypedData.reason({ domain: { chainId: 1 } }), /mainnet/u);
    assert.match(policy.refuseTypedData.reason({ domain: { chainId: '1' } }), /mainnet/u);
    assert.equal(policy.refuseTypedData.reason({ domain: { chainId: 11155111 } }), null);
    assert.equal(policy.refuseTypedData.reason({}), null);
    const forbidden = policy.signatureLog.forbiddenEntries;
    assert.equal(forbidden.blockedMainnet.match({ kind: 'blocked-mainnet', probe: false }), true);
    assert.equal(forbidden.blockedMainnet.match({ kind: 'blocked-mainnet', probe: true }), false);
    assert.equal(forbidden.refusedMainnet.match({ kind: 'refused-mainnet' }), true);
  });

  it('uses Node built-ins only, and the policy fence accepts it with its adapter module', async () => {
    const files = await libraryAdapterFiles(PLUGIN, {
      module: manifest.adapters['test-dapp'].module,
    });
    const covered = new Set(files.map((entry) => fs.realpathSync(path.join(PLUGIN, entry))));
    const { policy } = await adapter();
    assert.match(
      fencePolicy({ file: policy.module, covered, scope: 'plugins/test-dapp/ and actions/' }),
      /^[0-9a-f]{64}$/u,
    );
    const source = fs.readFileSync(policy.module, 'utf8');
    for (const [, specifier] of source.matchAll(/from '([^']+)'/gu))
      assert.match(specifier, /^node:/u, specifier);
  });
});
