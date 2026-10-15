import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { centerOfRect } from 'agent-device';

import { seedIOSGatewayProfile } from '../../../apps/companion/scripts/agentic/seed-ios-gateway-profile.mjs';

interface NativeUiNode {
  AXLabel?: string;
  frame: { x: number; y: number; width: number; height: number };
}
type WaitFor = <T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeout?: number,
) => Promise<T>;
interface CompanionProof {
  source: string;
  env: NodeJS.ProcessEnv;
  simulator: string;
  port: number;
  runId: string;
  ticket: string;
  token: string;
  out: string;
  waitFor: WaitFor;
  onProcess: (child: ChildProcess) => void;
}

/** Uses an owned proof simulator and the real profile, deep-link and run-view paths. */
export async function proveCompanionOperatorWait(
  input: CompanionProof,
): Promise<() => Promise<void>> {
  const { source, env, simulator, runId, ticket, token, out, waitFor } = input;
  const bundleId = 'net.siteed.farmslot.development';
  const origin = `http://localhost:${input.port}`;
  const version = JSON.parse(
    readFileSync(path.join(source, 'apps/companion/package.json'), 'utf8'),
  ).version;
  seedIOSGatewayProfile({
    simulator,
    bundleId,
    seenVersion: version,
    profile: {
      id: 'operator-wait-proof',
      name: 'Operator wait proof',
      url: env.FARMSLOT_GATEWAY,
      kind: 'custom',
      authMode: 'token',
      presetSecret: token,
    },
  });
  const metro = spawn(
    process.execPath,
    [
      '--dns-result-order=ipv4first',
      path.join(source, 'node_modules/expo/bin/cli'),
      'start',
      '--dev-client',
      '--localhost',
      '--port',
      String(input.port),
    ],
    {
      cwd: path.join(source, 'apps/companion'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        CI: '1',
        EXPO_OFFLINE: '1',
        EXPO_NO_DOTENV: '1',
        APP_VARIANT: 'development',
        METRO_PORT: String(input.port),
        FARMSLOT_LOCAL_RUNTIME_CONFIG: '1',
        EXPO_PUBLIC_GATEWAY_URL: env.FARMSLOT_GATEWAY,
        FARMSLOT_REMOTE_GATEWAY_URL: '',
        FARMSLOT_REMOTE_GATEWAY_TOKEN: '',
      },
    },
  );
  input.onProcess(metro);
  await waitFor(
    async () => {
      assert.equal(metro.exitCode, null, 'owned Companion Metro remains running');
      try {
        return (await fetch(`${origin}/status`)).ok;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    },
    Boolean,
    'Companion Metro',
  );
  const tree = (): NativeUiNode[] =>
    JSON.parse(
      execFileSync('idb', ['ui', 'describe-all', '--udid', simulator, '--json'], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      }),
    );
  const acceptLink = () => {
    const nodes = tree();
    if (nodes.some((node) => node.AXLabel === 'dev-tools')) {
      const dismiss =
        nodes.find((node) => node.AXLabel === 'Continue') ??
        nodes.find((node) => node.AXLabel === 'Close');
      assert.ok(dismiss);
      const point = centerOfRect(dismiss.frame);
      execFileSync(
        'idb',
        [
          'ui',
          'tap',
          String(Math.round(point.x)),
          String(Math.round(point.y)),
          '--udid',
          simulator,
        ],
        { timeout: 15_000 },
      );
      return;
    }
    if (
      nodes.some(
        (node) => node.AXLabel?.includes('Notifications') && node.AXLabel.includes('Farmslot'),
      )
    ) {
      const deny = nodes.find(
        (node) => node.AXLabel === "Don't Allow" || node.AXLabel === 'Don\u2019t Allow',
      );
      assert.ok(deny);
      const point = centerOfRect(deny.frame);
      execFileSync(
        'idb',
        [
          'ui',
          'tap',
          String(Math.round(point.x)),
          String(Math.round(point.y)),
          '--udid',
          simulator,
        ],
        {
          timeout: 15_000,
        },
      );
      return;
    }
    if (!nodes.some((node) => node.AXLabel?.startsWith('Open in'))) return;
    const open = nodes.find((node) => node.AXLabel === 'Open');
    assert.ok(open);
    const point = centerOfRect(open.frame);
    execFileSync(
      'idb',
      ['ui', 'tap', String(Math.round(point.x)), String(Math.round(point.y)), '--udid', simulator],
      {
        timeout: 15_000,
      },
    );
  };
  execFileSync('xcrun', ['simctl', 'launch', simulator, bundleId]);
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    simulator,
    `farmslot-development://expo-development-client/?url=${encodeURIComponent(origin)}`,
  ]);
  acceptLink();
  await waitFor(
    async () => {
      acceptLink();
      const targets: unknown = await (await fetch(`${origin}/json/list`)).json();
      return Array.isArray(targets) && targets.length > 0;
    },
    Boolean,
    'connected Companion',
  );
  execFileSync('xcrun', ['simctl', 'openurl', simulator, `farmslot-development:///run/${runId}`]);
  acceptLink();
  const waiting = (node: NativeUiNode) =>
    node.AXLabel?.includes('Waiting on operator: fixture-operator');
  const observed = await waitFor(
    () => {
      acceptLink();
      return tree();
    },
    (nodes) => nodes.some(waiting),
    'Companion operator wait',
  );
  writeFileSync(path.join(out, 'companion-wait-tree.json'), JSON.stringify(observed, null, 2));
  execFileSync('xcrun', [
    'simctl',
    'io',
    simulator,
    'screenshot',
    path.join(out, 'companion-wait.png'),
  ]);
  return async () => {
    const resumed = await waitFor(
      tree,
      (nodes) => !nodes.some(waiting) && nodes.some((node) => node.AXLabel?.includes(ticket)),
      'Companion wait clears',
      10_000,
    );
    writeFileSync(path.join(out, 'companion-resume-tree.json'), JSON.stringify(resumed, null, 2));
    execFileSync('xcrun', [
      'simctl',
      'io',
      simulator,
      'screenshot',
      path.join(out, 'companion-resume.png'),
    ]);
  };
}
