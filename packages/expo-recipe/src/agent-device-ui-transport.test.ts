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
        return {
          pressed: true,
          targetHittable: false,
          evidence: { changedFromBefore: true },
          settle: { settled: true },
        };
      },
      async fill(options: Record<string, unknown>) {
        calls.push({ method: 'fill', options });
        return {
          text: options.text,
          message: `Filled ${String(options.text)}`,
          backendResult: { value: options.text },
          settle: {
            settled: true,
            diff: { summary: { additions: 1 }, lines: [{ text: options.text }] },
          },
        };
      },
      async scroll(options: Record<string, unknown>) {
        calls.push({ method: 'scroll', options });
        return { scrolled: true };
      },
    },
    command: {
      async wait(options: Record<string, unknown>) {
        calls.push({ method: 'wait-stable', options });
        return { stable: true };
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
  const fillResult = await transport.execute(
    'ui.set_input',
    { test_id: 'secret-field', value: 'seed phrase secret' },
    context,
  );
  await transport.execute('ui.scroll', { direction: 'down', timeout_ms: 2_000 }, context);
  await transport.execute(
    'ui.wait_for',
    { text_contains: ['Settings', 'Gateway Connection'] },
    context,
  );
  assert.deepEqual(await transport.execute('ui.wait_for', { text: 'Settings' }, context), {
    matched: true,
    expected: 'present',
    stability: { stable: true },
  });
  for (const expected of ['hidden', 'not_present']) {
    const result = await transport.execute(
      'ui.wait_for',
      { text: 'Missing element', expected },
      context,
    );
    assert.deepEqual(result, {
      matched: true,
      expected: 'absent',
      stability: { stable: true },
    });
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
  assert.equal(calls.find((call) => call.method === 'wait-stable')?.options.stable, true);
  assert.equal(JSON.stringify(fillResult).includes('seed phrase secret'), false);
  assert.equal((fillResult as { redacted?: boolean }).redacted, true);
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
      press: async (options: Record<string, unknown>) => ({
        ...options,
        settle: { settled: true },
      }),
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

test('rejects unsettled native actions and warns for idempotent non-hittable actions', async () => {
  const results = [
    { settle: { settled: false, hint: 'UI kept changing' } },
    {
      settle: { settled: true },
      targetHittable: false,
      evidence: { changedFromBefore: false },
    },
  ];
  const client = {
    apps: { open: async () => ({ session: 's', identifiers: {} }) },
    interactions: { press: async () => results.shift() },
    sessions: { close: async () => ({ session: 's', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const transport = createAgentDeviceUiTransport({
    platform: 'ios',
    device: 'fs-3',
    app: 'net.siteed.farmslot.development',
    session: 's',
    client,
  });

  await assert.rejects(
    () => transport.execute('ui.press', { text: 'Settings' }, {} as ActionExecutionContext),
    /did not reach a settled native UI state: UI kept changing/u,
  );
  const result = await transport.execute(
    'ui.press',
    { text: 'Settings' },
    {} as ActionExecutionContext,
  );
  assert.match(
    (result as { warning?: string }).warning ?? '',
    /non-hittable target with no accessibility-tree change/u,
  );
});
