import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PNG } from 'pngjs';

import type { ActionExecutionContext } from '@farmslot/recipe-harness';

import {
  type AgentDeviceUiTransportOptions,
  createAgentDeviceUiTransport,
} from './agent-device-ui-transport.js';

test('captures a full native surface without stopping at a premature virtualized end marker', async () => {
  const artifactsDir = await mkdtemp(path.join(tmpdir(), 'farmslot-capture-surface-'));
  let position = 0;
  let bottomScrolls = 0;
  let bottomSwipeAttempts = 0;
  let dropNextBottomSwipe = true;
  let freezeCapture = false;
  let hideEndMarker = false;
  let omitScale = false;
  let failTopSwipe = false;
  let hideSurfaceMarker = false;
  let staleHiddenContentBelow = false;
  const client = {
    apps: { open: async () => ({ session: 'surface-session', identifiers: {} }) },
    interactions: {
      async scroll(options: Record<string, unknown>) {
        if (options.direction === 'top') position = 0;
        if (options.direction === 'down') {
          position = Math.min(20, position + 10);
          bottomScrolls += 1;
        }
        return { scrolled: true };
      },
      async swipe(options: Record<string, unknown>) {
        if (failTopSwipe) throw new Error('reset to top failed');
        const from = options.from as { y: number };
        const to = options.to as { y: number };
        if (from.y < to.y) position = Math.max(0, position - 10);
        if (from.y > to.y) {
          bottomSwipeAttempts += 1;
          if (dropNextBottomSwipe) {
            dropNextBottomSwipe = false;
            return { scrolled: false };
          }
          position = Math.min(20, position + 10);
          bottomScrolls += 1;
        }
        return { scrolled: true };
      },
    },
    command: { wait: async () => ({ stable: true }) },
    capture: {
      async snapshot() {
        return {
          nodes: [
            {
              identifier: 'nested-scroll-surface',
              type: 'ScrollView',
              rect: omitScale
                ? { x: 0, y: 1, width: 10, height: 18 }
                : { x: 0, y: 0, width: 5, height: 9 },
            },
            {
              identifier: hideSurfaceMarker ? undefined : 'catalog-surface',
              type: 'ScrollView',
              rect: omitScale
                ? { x: 0, y: 2, width: 10, height: 16 }
                : { x: 0, y: 1, width: 5, height: 8 },
              hiddenContentAbove: position > 0,
              hiddenContentBelow: position < 20 || staleHiddenContentBelow,
            },
            {
              type: 'Window',
              rect: omitScale
                ? { x: 0, y: 0, width: 10, height: 20 }
                : { x: 0, y: 0, width: 5, height: 10 },
            },
            ...(position > 0 && !hideEndMarker
              ? [
                  {
                    identifier: 'catalog-end',
                    type: 'View',
                    rect: omitScale
                      ? { x: 0, y: 16, width: 10, height: 1 }
                      : { x: 0, y: 8, width: 5, height: 1 },
                    visibleToUser: true,
                  },
                ]
              : []),
          ],
          truncated: false,
        };
      },
      async screenshot(options: Record<string, unknown>) {
        const image = new PNG({ width: 10, height: 20 });
        for (let y = 0; y < image.height; y += 1) {
          const documentValue =
            y < 2 ? 7 : y >= 18 ? 9 : ((freezeCapture ? 0 : position) + y - 2) * 7;
          for (let x = 0; x < image.width; x += 1) {
            const value = y >= 14 && y < 17 && x >= 8 ? 99 : documentValue;
            const offset = (y * image.width + x) * 4;
            image.data[offset] = value;
            image.data[offset + 1] = value;
            image.data[offset + 2] = value;
            image.data[offset + 3] = 255;
          }
        }
        await writeFile(String(options.path), PNG.sync.write(image));
        return {
          width: 10,
          height: 20,
          ...(omitScale ? {} : { logicalWidth: 5, logicalHeight: 10, pixelDensity: 2 }),
        };
      },
    },
    sessions: { close: async () => ({ session: 'surface-session', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const artifacts: unknown[] = [];
  const context = {
    nodeId: 'capture-catalog',
    artifactsDir,
    resolveArtifactPath: (relativePath: string) => path.join(artifactsDir, relativePath),
    registerArtifact: (artifact: unknown) => artifacts.push(artifact),
  } as ActionExecutionContext;
  const transport = createAgentDeviceUiTransport({
    platform: 'ios',
    device: 'fs-1',
    app: 'net.siteed.farmslot.development',
    session: 'surface-session',
    client,
  });

  try {
    const result = (await transport.execute(
      'ui.capture_surface',
      {
        path: 'screenshots/catalog.png',
        surface_test_id: 'catalog-surface',
        until_test_id: 'catalog-end',
        max_scrolls: 4,
      },
      context,
    )) as { output: { extent: string; viewports: number; height: number } };
    const image = PNG.sync.read(await readFile(path.join(artifactsDir, 'screenshots/catalog.png')));

    assert.equal(result.output.extent, 'full');
    assert.equal(result.output.viewports, 3);
    assert.equal(result.output.height, 40);
    assert.equal(image.height, 40);
    assert.equal(bottomScrolls, 2);
    assert.equal(bottomSwipeAttempts, 3);
    assert.equal(position, 0);
    assert.equal(artifacts.length, 1);
    assert.deepEqual([...image.data.subarray(0, 4)], [7, 7, 7, 255]);
    assert.deepEqual([...image.data.subarray(image.data.length - 4)], [9, 9, 9, 255]);
    assert.equal(
      [...Array(image.height).keys()].filter(
        (row) => image.data[(row * image.width + image.width - 1) * 4] === 99,
      ).length,
      3,
    );

    staleHiddenContentBelow = true;
    const staleHintResult = (await transport.execute(
      'ui.capture_surface',
      {
        path: 'screenshots/stale-hidden-content-hint.png',
        surface_test_id: 'catalog-surface',
        until_test_id: 'catalog-end',
        max_scrolls: 4,
      },
      context,
    )) as { output: { extent: string; viewports: number } };
    assert.equal(staleHintResult.output.extent, 'full');
    assert.equal(staleHintResult.output.viewports, 3);
    assert.equal(artifacts.length, 2);
    staleHiddenContentBelow = false;

    freezeCapture = true;
    hideEndMarker = true;
    await assert.rejects(
      () =>
        transport.execute(
          'ui.capture_surface',
          {
            path: 'screenshots/incomplete.png',
            surface_test_id: 'catalog-surface',
            until_test_id: 'catalog-end',
            max_scrolls: 2,
          },
          context,
        ),
      /(?:stopped moving before reaching|did not reach the end)/u,
    );
    assert.equal(artifacts.length, 2);

    freezeCapture = false;
    hideEndMarker = false;
    omitScale = true;
    const androidTransport = createAgentDeviceUiTransport({
      platform: 'android',
      device: 'emulator-5554',
      app: 'net.siteed.farmslot.development',
      session: 'android-surface-session',
      client,
    });
    const androidResult = (await androidTransport.execute(
      'ui.capture_surface',
      {
        path: 'screenshots/android-catalog.png',
        surface_test_id: 'catalog-surface',
        until_test_id: 'catalog-end',
        max_scrolls: 2,
      },
      context,
    )) as { output: { width: number; viewports: number } };
    assert.equal(androidResult.output.width, 10);
    assert.equal(androidResult.output.viewports, 3);
    assert.equal(artifacts.length, 3);

    hideSurfaceMarker = true;
    await assert.rejects(
      () =>
        androidTransport.execute(
          'ui.capture_surface',
          {
            path: 'screenshots/missing-surface.png',
            surface_test_id: 'catalog-surface',
            until_test_id: 'catalog-end',
            max_scrolls: 2,
          },
          context,
        ),
      /could not resolve surface_test_id=catalog-surface/u,
    );
    assert.equal(artifacts.length, 3);
    hideSurfaceMarker = false;

    await assert.rejects(
      () =>
        transport.execute(
          'ui.capture_surface',
          {
            path: 'screenshots/missing-scale.png',
            surface_test_id: 'catalog-surface',
            until_test_id: 'catalog-end',
            max_scrolls: 2,
          },
          context,
        ),
      /requires screenshot logical dimensions or pixel density/u,
    );
    assert.equal(artifacts.length, 3);

    omitScale = false;
    failTopSwipe = true;
    await assert.rejects(
      () =>
        transport.execute(
          'ui.capture_surface',
          {
            path: 'screenshots/restore-failed.png',
            surface_test_id: 'catalog-surface',
            until_test_id: 'catalog-end',
            max_scrolls: 2,
          },
          context,
        ),
      /reset to top failed/u,
    );
    assert.equal(artifacts.length, 3);
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

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
      async keyboard(options: Record<string, unknown>) {
        calls.push({ method: 'keyboard', options });
        return { action: options.action };
      },
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
              visibleToUser: true,
            },
            {
              label: 'Gateway Connection',
              type: 'StaticText',
            },
            {
              identifier: 'covered-cta',
              label: 'Covered CTA',
              type: 'button',
              visibleToUser: true,
              interactionBlocked: 'covered',
            },
            {
              identifier: 'ghost-cta',
              label: 'Ghost CTA',
              type: 'button',
              visibleToUser: false,
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
  await transport.execute('ui.key_press', { key: 'Escape' }, context);
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
      expected,
      stability: { stable: true },
    });
  }
  assert.deepEqual(
    await transport.execute('ui.wait_for', { text: 'Missing element', hidden: true }, context),
    { matched: true, expected: 'hidden', stability: { stable: true } },
  );
  assert.deepEqual(await transport.execute('ui.wait_for', { test_id: 'covered-cta' }, context), {
    matched: true,
    expected: 'present',
    stability: { stable: true },
  });
  assert.deepEqual(
    await transport.execute('ui.wait_for', { test_id: 'covered-cta', expected: 'hidden' }, context),
    { matched: true, expected: 'hidden', stability: { stable: true } },
  );
  assert.deepEqual(
    await transport.execute(
      'ui.wait_for',
      { test_id: 'settings-tab', expected: 'visible' },
      context,
    ),
    { matched: true, expected: 'visible', stability: { stable: true } },
  );
  await assert.rejects(
    () =>
      transport.execute(
        'ui.wait_for',
        { test_id: 'covered-cta', expected: 'visible', timeout_ms: 1 },
        context,
      ),
    /ui\.wait_for timed out/u,
  );
  await assert.rejects(
    () =>
      transport.execute(
        'ui.wait_for',
        { test_id: 'ghost-cta', expected: 'visible', timeout_ms: 1 },
        context,
      ),
    /ui\.wait_for timed out/u,
  );
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
  assert.equal(calls.find((call) => call.method === 'keyboard')?.options.action, 'dismiss');
  assert.ok(
    calls
      .filter((call) => call.method === 'snapshot')
      .every((call) => call.options.forceFull === true),
  );
  assert.equal(JSON.stringify(fillResult).includes('seed phrase secret'), false);
  assert.equal((fillResult as { redacted?: boolean }).redacted, true);
  assert.deepEqual(observed?.observations?.['ui.screen'], {
    provider: 'agent-device',
    name: 'Farmslot Dev',
    app_id: 'net.siteed.farmslot.development',
  });
  assert.equal((observed?.observations?.['ui.visible'] as { items: unknown[] }).items.length, 1);
  assert.deepEqual(
    (observed?.observations?.['ui.visible'] as { hidden_or_offscreen: unknown[] })
      .hidden_or_offscreen,
    [
      { test_id: 'covered-cta', role: 'button', reason: 'covered' },
      { test_id: 'ghost-cta', role: 'button', reason: 'hidden_or_offscreen' },
    ],
  );
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

test('fails when an observable Android input remains empty after repair', async () => {
  let fills = 0;
  const commands: string[][] = [];
  const client = {
    apps: { open: async () => ({ session: 'input-session', identifiers: {} }) },
    interactions: {
      fill: async () => {
        fills += 1;
        return { settle: { settled: true } };
      },
      press: async () => ({ pressed: true }),
    },
    capture: {
      snapshot: async () => ({
        nodes: [{ identifier: 'field', value: '' }],
        truncated: false,
      }),
    },
    sessions: { close: async () => ({ session: 'input-session', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const transport = createAgentDeviceUiTransport({
    platform: 'android',
    device: 'physical-serial',
    app: 'io.metamask',
    session: 'input-session',
    client,
    adbPath: '/tools/adb',
    gestureCommandRunner: {
      async execFile(_file, args) {
        commands.push(args);
        return {};
      },
    },
  });

  await assert.rejects(
    () =>
      transport.execute(
        'ui.set_input',
        { test_id: 'field', value: 'expected' },
        {} as ActionExecutionContext,
      ),
    /could not replace the Android field; expected 8 characters and observed 0/u,
  );
  assert.equal(fills, 2);
  assert.deepEqual(commands, [['-s', 'physical-serial', 'shell', 'input', 'keyevent', '123']]);
});

test('does not treat an Android input label as its value', async () => {
  let fills = 0;
  const client = {
    apps: { open: async () => ({ session: 'input-session', identifiers: {} }) },
    interactions: {
      fill: async () => {
        fills += 1;
        return { settle: { settled: true } };
      },
      press: async () => ({ pressed: true }),
    },
    capture: {
      snapshot: async () => ({
        nodes: [{ identifier: 'field', label: 'Email' }],
        truncated: false,
      }),
    },
    sessions: { close: async () => ({ session: 'input-session', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const transport = createAgentDeviceUiTransport({
    platform: 'android',
    device: 'physical-serial',
    app: 'io.metamask',
    session: 'input-session',
    client,
  });

  await transport.execute(
    'ui.set_input',
    { test_id: 'field', value: 'expected' },
    {} as ActionExecutionContext,
  );

  assert.equal(fills, 1);
});

test('fails when a masked Android input cannot be cleared before replacement', async () => {
  let fills = 0;
  const commands: string[][] = [];
  const client = {
    apps: { open: async () => ({ session: 'input-session', identifiers: {} }) },
    interactions: {
      fill: async () => {
        fills += 1;
        return { settle: { settled: true } };
      },
      press: async () => ({ pressed: true }),
    },
    capture: {
      snapshot: async () => ({
        nodes: [{ identifier: 'field', value: '••••' }],
        truncated: false,
      }),
    },
    sessions: { close: async () => ({ session: 'input-session', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const transport = createAgentDeviceUiTransport({
    platform: 'android',
    device: 'physical-serial',
    app: 'io.metamask',
    session: 'input-session',
    client,
    adbPath: '/tools/adb',
    gestureCommandRunner: {
      async execFile(_file, args) {
        commands.push(args);
        return {};
      },
    },
  });

  await assert.rejects(
    () =>
      transport.execute(
        'ui.set_input',
        { test_id: 'field', value: 'expected' },
        {} as ActionExecutionContext,
      ),
    /could not clear the Android field before replacement/u,
  );
  assert.equal(fills, 1);
  assert.deepEqual(commands, [
    ['-s', 'physical-serial', 'shell', 'input', 'keyevent', '123'],
    ['-s', 'physical-serial', 'shell', 'input', 'keyevent', '67', '67', '67', '67'],
  ]);
});

test('streams all continuous gestures from resolved native target coordinates', async () => {
  for (const platform of ['ios', 'android'] as const) {
    const commands: Array<{ file: string; args: string[] }> = [];
    const client = {
      apps: { open: async () => ({ session: 'gesture-session', identifiers: {} }) },
      interactions: {
        press: async () => ({ ok: true }),
        fill: async () => ({ ok: true }),
        scroll: async () => ({ ok: true }),
      },
      command: { wait: async () => ({ stable: true }) },
      capture: {
        async snapshot() {
          return {
            nodes: [
              {
                identifier: 'gesture-target',
                rect: { x: 10.2, y: 20.2, width: 99.4, height: 39.4 },
              },
            ],
            truncated: false,
          };
        },
        screenshot: async () => ({}),
      },
      sessions: { close: async () => ({ session: 'gesture-session', identifiers: {} }) },
    } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
    const transport = createAgentDeviceUiTransport({
      platform,
      device: platform === 'ios' ? 'gesture-ios' : 'emulator-5554',
      app: 'net.siteed.farmslot.development',
      session: 'gesture-session',
      client,
      idbPath: '/tools/idb',
      adbPath: '/tools/adb',
      gestureCommandRunner: {
        async execFile(file, args) {
          commands.push({ file, args });
          if (args[0] === 'list-targets') {
            return {
              stdout:
                '{"name":"gesture-ios","udid":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","state":"Booted"}\n',
            };
          }
          return {};
        },
      },
    });

    const cases = [
      {
        action: 'ui.swipe',
        node: {
          target: 'gesture-target',
          direction: 'up',
          distance: 30,
          duration_ms: 300,
          settle: false,
        },
        end: { x: 60, y: 10 },
      },
      {
        action: 'ui.pan',
        node: {
          target: 'gesture-target',
          path: [{ x: 19.6, y: 0.4 }],
          duration_ms: 400,
          settle: false,
        },
        end: { x: 80, y: 40 },
      },
      {
        action: 'ui.drag',
        node: {
          target: 'gesture-target',
          path: [{ x: 50.2, y: -0.2 }],
          duration_ms: 500,
          settle: false,
        },
        end: { x: 110, y: 40 },
      },
      {
        action: 'ui.long_press',
        node: { target: 'gesture-target', hold_ms: 700, settle: false },
        end: { x: 60, y: 40 },
      },
    ] as const;

    for (const fixture of cases) {
      const result = (await transport.execute(
        fixture.action,
        fixture.node,
        {} as ActionExecutionContext,
      )) as {
        output: { resolvedStart: { x: number; y: number }; resolvedEnd: { x: number; y: number } };
        phases: Array<{ phase: string; x: number; y: number }>;
      };
      assert.deepEqual(result.output.resolvedStart, { x: 60, y: 40 });
      assert.deepEqual(result.output.resolvedEnd, fixture.end);
      assert.equal(result.phases[0]?.phase, 'start');
      assert.equal(result.phases.at(-1)?.phase, 'end');
    }

    assert.deepEqual(commands, expectedNativeGestureCommands(platform));
  }
});

function expectedNativeGestureCommands(
  platform: 'ios' | 'android',
): Array<{ file: string; args: string[] }> {
  if (platform === 'ios') {
    const swipe = (from: [number, number], to: [number, number], seconds: string) => ({
      file: '/tools/idb',
      args: [
        'ui',
        'swipe',
        String(from[0]),
        String(from[1]),
        String(to[0]),
        String(to[1]),
        '--duration',
        seconds,
        '--udid',
        'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      ],
    });
    return [
      { file: '/tools/idb', args: ['list-targets', '--json'] },
      swipe([60, 40], [60, 10], '0.3'),
      swipe([60, 40], [80, 40], '0.4'),
      swipe([60, 40], [110, 40], '0.5'),
      {
        file: '/tools/idb',
        args: [
          'ui',
          'tap',
          '60',
          '40',
          '--duration',
          '0.7',
          '--udid',
          'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
        ],
      },
    ];
  }
  const adb = (...args: string[]) => ({
    file: '/tools/adb',
    args: ['-s', 'emulator-5554', 'shell', 'input', ...args],
  });
  return [
    adb('swipe', '60', '40', '60', '10', '300'),
    adb('swipe', '60', '40', '80', '40', '400'),
    adb('swipe', '60', '40', '110', '40', '500'),
    adb('swipe', '60', '40', '60', '40', '700'),
  ];
}

test('native transports fail closed on multi-point paths', async () => {
  const client = {
    apps: { open: async () => ({ session: 'gesture-session', identifiers: {} }) },
    interactions: {
      press: async () => ({ ok: true }),
      fill: async () => ({ ok: true }),
      scroll: async () => ({ ok: true }),
    },
    command: { wait: async () => ({ stable: true }) },
    capture: {
      snapshot: async () => ({ nodes: [], truncated: false }),
      screenshot: async () => ({}),
    },
    sessions: { close: async () => ({ session: 'gesture-session', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const node = {
    target: { x: 10.4, y: 20.4 },
    path: [
      { x: 20.6, y: 0.3 },
      { x: 40.2, y: 10.7 },
    ],
    duration_ms: 2,
    settle: false,
  };
  const androidCommands: string[][] = [];
  const android = createAgentDeviceUiTransport({
    platform: 'android',
    device: 'emulator-5554',
    app: 'net.siteed.farmslot.development',
    session: 'gesture-session',
    client,
    adbPath: '/tools/adb',
    gestureCommandRunner: {
      async execFile(_file, args) {
        androidCommands.push(args);
        return {};
      },
    },
  });

  for (const action of ['ui.pan', 'ui.drag'] as const) {
    await assert.rejects(
      () => android.execute(action, node, {} as ActionExecutionContext),
      new RegExp(
        `android ${action.replace('.', '\\.')} cannot stream a multi-point path\\. Next: use one path point or delta\\.`,
        'u',
      ),
    );
  }
  assert.deepEqual(androidCommands, []);

  const iosCommands: string[][] = [];
  const ios = createAgentDeviceUiTransport({
    platform: 'ios',
    device: 'gesture-ios',
    app: 'net.siteed.farmslot.development',
    session: 'gesture-session',
    client,
    idbPath: '/tools/idb',
    gestureCommandRunner: {
      async execFile(_file, args) {
        iosCommands.push(args);
        if (args[0] === 'list-targets') {
          return {
            stdout:
              '{"name":"gesture-ios","udid":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","state":"Booted"}\n',
          };
        }
        return {};
      },
    },
  });

  for (const action of ['ui.pan', 'ui.drag'] as const) {
    await assert.rejects(
      () => ios.execute(action, node, {} as ActionExecutionContext),
      new RegExp(
        `ios ${action.replace('.', '\\.')} cannot stream a multi-point path\\. Next: use one path point or delta\\.`,
        'u',
      ),
    );
  }
  assert.deepEqual(iosCommands, [['list-targets', '--json']]);
});

test('native gesture discovery retries after tool and device resolution failures', async () => {
  const client = {
    apps: { open: async () => ({ session: 'gesture-session', identifiers: {} }) },
    interactions: {
      press: async () => ({ ok: true }),
      fill: async () => ({ ok: true }),
      scroll: async () => ({ ok: true }),
    },
    command: { wait: async () => ({ stable: true }) },
    capture: {
      snapshot: async () => ({ nodes: [], truncated: false }),
      screenshot: async () => ({}),
    },
    sessions: { close: async () => ({ session: 'gesture-session', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  let whichAttempts = 0;
  let deviceAttempts = 0;
  const transport = createAgentDeviceUiTransport({
    platform: 'ios',
    device: 'gesture-ios',
    app: 'net.siteed.farmslot.development',
    session: 'gesture-session',
    client,
    gestureCommandRunner: {
      async execFile(_file, args) {
        if (args[0] === 'idb') {
          whichAttempts += 1;
          return whichAttempts === 1 ? {} : { stdout: '/tools/idb\n' };
        }
        if (args[0] === 'list-targets') {
          deviceAttempts += 1;
          return deviceAttempts === 1
            ? {}
            : {
                stdout:
                  '{"name":"gesture-ios","udid":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","state":"Booted"}\n',
              };
        }
        return {};
      },
    },
  });
  const node = {
    target: { x: 20, y: 40 },
    hold_ms: 1,
    settle: false,
  };

  await assert.rejects(
    () => transport.execute('ui.long_press', node, {} as ActionExecutionContext),
    /requires idb/u,
  );
  await assert.rejects(
    () => transport.execute('ui.long_press', node, {} as ActionExecutionContext),
    /could not resolve simulator gesture-ios/u,
  );
  await transport.execute('ui.long_press', node, {} as ActionExecutionContext);

  assert.equal(whichAttempts, 2);
  assert.equal(deviceAttempts, 2);
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
  assert.equal((result as { serial?: string }).serial, 'emulator-5554');
  assert.equal((result as { device?: string }).device, undefined);
});

test('settle false skips native stability enforcement', async () => {
  const calls: Array<{ method: string; options: Record<string, unknown> }> = [];
  const client = {
    apps: { open: async () => ({ session: 's', identifiers: {} }) },
    interactions: {
      press: async (options: Record<string, unknown>) => {
        calls.push({ method: 'press', options });
        return { pressed: true };
      },
    },
    sessions: { close: async () => ({ session: 's', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const transport = createAgentDeviceUiTransport({
    platform: 'ios',
    device: 'fs-3',
    app: 'net.siteed.farmslot.development',
    session: 's',
    client,
  });

  await transport.execute(
    'ui.press',
    { text: 'Live status', settle: false },
    {} as ActionExecutionContext,
  );

  assert.equal(calls[0]?.options.settle, false);
});

test('warns on unsettled native actions and idempotent non-hittable actions', async () => {
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

  const unsettled = await transport.execute(
    'ui.press',
    { text: 'Settings' },
    {} as ActionExecutionContext,
  );
  assert.match(
    (unsettled as { settlementWarning?: string }).settlementWarning ?? '',
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

test('stability-wait failures after scroll and unsettled fills surface as warnings', async () => {
  const client = {
    apps: { open: async () => ({ session: 's', identifiers: {} }) },
    interactions: {
      scroll: async () => ({ scrolled: true }),
      fill: async (options: Record<string, unknown>) => ({
        text: options.text,
        settle: { settled: false, hint: 'keyboard animation' },
      }),
    },
    command: {
      wait: async () => {
        throw new Error('UI never became stable');
      },
    },
    sessions: { close: async () => ({ session: 's', identifiers: {} }) },
  } as unknown as NonNullable<AgentDeviceUiTransportOptions['client']>;
  const transport = createAgentDeviceUiTransport({
    platform: 'ios',
    device: 'fs-3',
    app: 'net.siteed.farmslot.development',
    session: 's',
    client,
  });

  const scrolled = await transport.execute(
    'ui.scroll',
    { direction: 'down' },
    {} as ActionExecutionContext,
  );
  assert.equal((scrolled as { scrolled?: boolean }).scrolled, true);
  assert.match(
    (scrolled as { settlementWarning?: string }).settlementWarning ?? '',
    /ui\.scroll did not reach a settled native UI state: UI never became stable/u,
  );

  const filled = await transport.execute(
    'ui.set_input',
    { test_id: 'field', value: 'secret text' },
    {} as ActionExecutionContext,
  );
  assert.equal(JSON.stringify(filled).includes('secret text'), false);
  assert.match(
    (filled as { settlementWarning?: string }).settlementWarning ?? '',
    /ui\.set_input did not reach a settled native UI state: keyboard animation/u,
  );
});
