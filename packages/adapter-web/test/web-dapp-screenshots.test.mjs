import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebDappAdapter } from '../src/web-dapp/index.mjs';

test('web-dapp configures native screenshots on its host CDP factory and preserves host hooks', async () => {
  const getPage = async () => assert.fail('configuration test must not connect to a browser');
  const base = { execute: async () => assert.fail('configuration test must not run an action') };
  const execute = async () => 'host action';
  let targetCalls = 0;
  const actions = {
    manifestPath: () => 'host-actions.json',
    semantic: [],
    cdpTarget: { transport: 'chrome-cdp', probePath: 'json/version' },
    ui(harness, options) {
      assert.equal(this, actions);
      assert.equal(options.hudPolicy, 'show');
      return { base: harness.createCdpWebUiTransport({ getPage }), execute };
    },
  };
  const recording = {
    target: async () => {
      targetCalls++;
      throw new Error('Foreign browser ownership');
    },
  };
  const adapter = createWebDappAdapter({ hooks: { actions, recording } });
  let configured;
  const transport = adapter.actions.ui(
    {
      createCdpWebUiTransport: (options) => {
        configured = options;
        return base;
      },
      createReactNativeBridgeUiTransport: () => assert.fail('web screenshots do not use a device'),
    },
    { hudPolicy: 'show' },
  );
  assert.equal(transport.base, base);
  assert.equal(transport.execute, execute);
  assert.equal(configured.getPage, getPage);
  assert.equal(configured.screenshotProvider.name, 'capture-helper');
  await assert.rejects(
    configured.screenshotProvider.capture({ context: { projectRoot: '/fixture', env: {} } }),
    /Foreign browser ownership/,
  );
  assert.equal(targetCalls, 1);
  assert.equal(adapter.recording, recording);
  assert.deepEqual(adapter.readiness.captureProviders, ['capture-helper', 'cdp']);
});

test('web-dapp does not add a transport when the host has no UI hook', () => {
  const adapter = createWebDappAdapter();
  assert.equal(adapter.actions.ui, undefined);
});
