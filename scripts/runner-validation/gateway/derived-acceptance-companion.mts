// Native Companion rendering only. Creates and deletes one owned simulator.
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { centerOfRect } from 'agent-device';

const exec = promisify(execFile);
interface UiNode {
  AXLabel?: string;
  AXUniqueId?: string;
  frame: { x: number; y: number; width: number; height: number };
}
export async function proveCompanionAcceptance(input: {
  source: string;
  output: string;
  gateway: string;
  credential: string;
  runId: string;
  app: string;
  criteria: string[];
}) {
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const address = portServer.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  let simulator: string | undefined;
  let metro: ChildProcess | undefined;
  const logs: string[] = [];
  const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
  const command = async (binary: string, args: string[], timeout = 60_000) =>
    (await exec(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const wait = async (read: () => Promise<boolean>, label: string, timeout = 180_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await read()) return;
      await pause();
    }
    throw new Error(`Timed out: ${label}`);
  };
  const tree = async (): Promise<UiNode[]> =>
    JSON.parse(await command('idb', ['ui', 'describe-all', '--udid', simulator!, '--json']));
  const tap = async (node: UiNode) => {
    const point = centerOfRect(node.frame);
    await command('idb', [
      'ui',
      'tap',
      String(Math.round(point.x)),
      String(Math.round(point.y)),
      '--udid',
      simulator!,
    ]);
  };
  const dismiss = async (nodes: UiNode[]) => {
    const open = nodes.find(({ AXLabel }) => AXLabel === 'Open');
    if (open && nodes.some(({ AXLabel }) => AXLabel?.startsWith('Open in'))) {
      await tap(open);
      return true;
    }
    const onboarding = nodes.find(
      ({ AXLabel }) =>
        AXLabel === 'Got it' ||
        (AXLabel === 'Continue' &&
          nodes.some((node) => node.AXLabel?.includes('This is the developer menu'))),
    );
    if (onboarding) {
      await tap(onboarding);
      return true;
    }
    return false;
  };
  try {
    simulator = (
      await command('xcrun', [
        'simctl',
        'create',
        `cx-runs-derived-ac-${Date.now()}`,
        'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      ])
    ).trim();
    assert.match(simulator, /^[0-9A-F-]{36}$/);
    await writeFile(
      path.join(input.output, 'companion-owned-simulator.json'),
      JSON.stringify({ udid: simulator, app: input.app }) + '\n',
    );
    await command('xcrun', ['simctl', 'boot', simulator]);
    await command('xcrun', ['simctl', 'bootstatus', simulator, '-b'], 180_000);
    await command('xcrun', ['simctl', 'install', simulator, input.app]);
    metro = spawn(
      process.execPath,
      [
        '--dns-result-order=ipv4first',
        path.join(input.source, 'node_modules/expo/bin/cli'),
        'start',
        '--dev-client',
        '--localhost',
        '--port',
        String(port),
      ],
      {
        cwd: path.join(input.source, 'apps/companion'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CI: '1',
          EXPO_OFFLINE: '1',
          EXPO_NO_DOTENV: '1',
          APP_VARIANT: 'development',
          METRO_PORT: String(port),
          FARMSLOT_LOCAL_RUNTIME_CONFIG: '1',
          EXPO_PUBLIC_GATEWAY_URL: input.gateway,
          FARMSLOT_REMOTE_GATEWAY_URL: input.gateway,
          FARMSLOT_REMOTE_GATEWAY_TOKEN: input.credential,
          EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE: '1',
        },
      },
    );
    metro.stdout?.on('data', (chunk) => logs.push(String(chunk)));
    metro.stderr?.on('data', (chunk) => logs.push(String(chunk)));
    const origin = `http://127.0.0.1:${port}`;
    await wait(
      async () => {
        assert.equal(metro!.exitCode, null, 'Owned Metro must remain alive');
        try {
          return (await fetch(`${origin}/status`)).ok;
        } catch (error) {
          if (error instanceof TypeError) return false;
          throw error;
        }
      },
      'Companion Metro readiness',
      90_000,
    );
    await command('xcrun', ['simctl', 'launch', simulator, 'net.siteed.farmslot.development']);
    await command('xcrun', [
      'simctl',
      'openurl',
      simulator,
      `farmslot-development://expo-development-client/?url=${encodeURIComponent(origin)}`,
    ]);
    await wait(async () => {
      await dismiss(await tree());
      const targets = await (await fetch(`${origin}/json/list`)).json();
      return Array.isArray(targets) && targets.length > 0;
    }, 'native Companion bundle');
    await command('xcrun', [
      'simctl',
      'openurl',
      simulator,
      `farmslot-development:///run/${input.runId}`,
    ]);
    let last: UiNode[] = [];
    const seen = new Set<string>();
    await wait(async () => {
      last = await tree();
      if (await dismiss(last)) return false;
      for (const node of last)
        for (const text of input.criteria) if (node.AXLabel?.includes(text)) seen.add(text);
      const panel = last.find(({ AXLabel }) => AXLabel?.startsWith('Acceptance criteria:'));
      if (panel) await tap(panel);
      if (input.criteria.every((text) => seen.has(text))) return true;
      await command('idb', [
        'ui',
        'swipe',
        '200',
        '650',
        '200',
        '250',
        '--duration',
        '0.3',
        '--udid',
        simulator!,
      ]);
      return false;
    }, 'all registered native acceptance rows');
    await writeFile(
      path.join(input.output, 'companion-acceptance-tree.json'),
      JSON.stringify(last, null, 2) + '\n',
    );
    await command('xcrun', [
      'simctl',
      'io',
      simulator,
      'screenshot',
      path.join(input.output, 'companion-acceptance.png'),
    ]);
    return {
      surface: 'Native Companion',
      criterionCount: seen.size,
      runId: input.runId,
      simulator,
      source: 'current worktree Metro',
      setup:
        'fresh owned simulator with copied app bundle only and ephemeral private gateway fixture',
    };
  } finally {
    const errors: unknown[] = [];
    if (metro && metro.exitCode === null) {
      try {
        metro.kill('SIGTERM');
        await once(metro, 'exit');
      } catch (error) {
        errors.push(error);
      }
    }
    if (simulator) {
      try {
        await command('xcrun', ['simctl', 'shutdown', simulator]);
        await command('xcrun', ['simctl', 'delete', simulator]);
      } catch (error) {
        errors.push(error);
      }
    }
    // The log may include a manifest with the disposable credential. Redact it.
    await writeFile(
      path.join(input.output, 'companion-metro.log'),
      logs.join('').replaceAll(input.credential, '[proof credential]'),
    );
    if (errors.length) throw new AggregateError(errors, 'Owned Companion proof cleanup failed');
  }
}
