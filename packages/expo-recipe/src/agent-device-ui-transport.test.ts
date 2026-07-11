import assert from 'node:assert/strict';
import test from 'node:test';

import type { ActionExecutionContext } from '@farmslot/recipe-harness';

import {
  type AgentDeviceUiTransportOptions,
  createAgentDeviceUiTransport,
} from './agent-device-ui-transport.js';

test('drives native actions, observations, artifacts, and non-owning cleanup', async () => {
  const calls: Array<{ method: string; options: Record<string, unknown> }> = [];
  const client = {
    apps: {
      async open(options: Record<string, unknown>) {
        calls.push({ method: 'open', options });
        return { session: 'recipe-session', identifiers: {} };
      },
    },
    interactions: {
      async press(options: Record<string, unknown>) {
        calls.push({ method: 'press', options });
        return { pressed: true };
      },
      async fill(options: Record<string, unknown>) {
        calls.push({ method: 'fill', options });
        return { filled: true };
      },
      async scroll(options: Record<string, unknown>) {
        calls.push({ method: 'scroll', options });
        return { scrolled: true };
      },
    },
    capture: {
      async snapshot(options: Record<string, unknown>) {
        calls.push({ method: 'snapshot', options });
        return {
          nodes: [
            {
              identifier: 'settings-tab',
              label: 'Settings, tab, 8 of 8',
              type: 'button',
            },
            {
              label: 'Gateway Connection',
              type: 'StaticText',
            },
          ],
          truncated: false,
          appName: 'Farmslot Dev',
          appBundleId: 'net.siteed.farmslot.development',
          identifiers: {},
        };
      },
      async screenshot(options: Record<string, unknown>) {
        calls.push({ method: 'screenshot', options });
        return { path: options.path, width: 402, height: 874, identifiers: {} };
      },
    },
    sessions: {
      async close(options: Record<string, unknown>) {
        calls.push({ method: 'close', options });
        return { session: 'recipe-session', identifiers: {} };
      },
    },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const artifacts: unknown[] = [];
  const context = {
    nodeId: 'open-settings',
    artifactsDir: '/tmp/artifacts',
    resolveArtifactPath: (relativePath: string) => `/tmp/artifacts/${relativePath}`,
    registerArtifact: (artifact: unknown) => artifacts.push(artifact),
  } as ActionExecutionContext;
  const transport = createAgentDeviceUiTransport({
    platform: 'ios',
    device: 'fs-3',
    app: 'net.siteed.farmslot.development',
    session: 'recipe-session',
    client,
  });

  await transport.execute('ui.press', { test_id: 'settings-tab', timeout_ms: 2_000 }, context);
  await transport.execute(
    'ui.wait_for',
    { text_contains: ['Settings', 'Gateway Connection'] },
    context,
  );
  for (const expected of ['hidden', 'not_present']) {
    const result = await transport.execute(
      'ui.wait_for',
      { text: 'Missing element', expected },
      context,
    );
    assert.deepEqual(result, { matched: true, expected: 'absent' });
  }
  await assert.rejects(
    () => transport.execute('ui.wait_for', { text: 'button', timeout_ms: 1 }, context),
    /ui\.wait_for timed out/u,
  );
  await assert.rejects(
    () => transport.execute('ui.wait_for', { text_contains: ['button'], timeout_ms: 1 }, context),
    /ui\.wait_for timed out/u,
  );
  const observed = await transport.observe?.(
    ['ui.screen', 'ui.visible', 'companion.custom'],
    {},
    context,
  );
  const screenshot = await transport.execute(
    'ui.screenshot',
    { path: 'screenshots/settings.png' },
    context,
  );
  await transport.close();

  assert.equal(calls.filter((call) => call.method === 'open').length, 1);
  assert.equal(
    calls.find((call) => call.method === 'press')?.options.selector,
    'id="settings-tab"',
  );
  assert.deepEqual(observed?.observations?.['ui.screen'], {
    provider: 'agent-device',
    name: 'Farmslot Dev',
    app_id: 'net.siteed.farmslot.development',
  });
  assert.equal((observed?.observations?.['ui.visible'] as { items: unknown[] }).items.length, 1);
  assert.deepEqual(observed?.warnings, [
    {
      ref: 'companion.custom',
      message: 'Agent Device does not support UI observer companion.custom.',
    },
  ]);
  assert.equal(artifacts.length, 1);
  assert.equal(
    (screenshot as { control?: { artifacts?: Array<{ path: string }> } }).control?.artifacts?.[0]
      ?.path,
    'screenshots/settings.png',
  );
  assert.equal(calls.find((call) => call.method === 'close')?.options.shutdown, false);
});

test('observe false remains a harness concern and does not alter provider selectors', async () => {
  const client = {
    apps: { open: async () => ({ session: 's', identifiers: {} }) },
    interactions: {
      press: async (options: Record<string, unknown>) => options,
    },
    sessions: { close: async () => ({ session: 's', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const transport = createAgentDeviceUiTransport({
    platform: 'android',
    device: 'emulator-5554',
    app: 'net.siteed.farmslot.development',
    session: 's',
    client,
  });
  const result = await transport.execute(
    'ui.press',
    { text: 'Settings', observe: false },
    {} as ActionExecutionContext,
  );
  assert.equal((result as { selector: string }).selector, 'label="Settings"');
});
