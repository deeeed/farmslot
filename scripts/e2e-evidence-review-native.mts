/** Manual native proof through the existing device transport and production Gateway. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createAgentDeviceUiTransport } from '../packages/adapter-rn/src/agent-device-ui-transport.js';
import type { ActionExecutionContext } from '../packages/recipe-runner/src/core/types.js';

const stateFile = process.argv[2];
const simulator = process.env.IOS_SIMULATOR;
assert(stateFile && simulator, 'Supply the isolated proof state and owned IOS_SIMULATOR.');
const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
const run = state.runs.find((run: { label: string }) => run.label === 'qa-multi-case-proof');
assert(run);
const root = process.cwd();
const runDetail = JSON.parse(
  execFileSync(
    process.execPath,
    [
      path.join(root, 'apps/command-center/scripts/cdp.mjs'),
      'gateway',
      'run.get',
      JSON.stringify({ runId: run.id }),
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, FARMSLOT_GATEWAY: `ws://127.0.0.1:${state.gatewayPort}` },
    },
  ),
).run;
const decision = runDetail.decisions.find(
  (decision: { payload?: { kind: string } }) => decision.payload?.kind === 'output-review',
);
assert(decision);
const artifactsDir = path.join(path.dirname(stateFile), 'native-proof');
await fs.mkdir(artifactsDir, { recursive: true });
const transport = createAgentDeviceUiTransport({
  platform: 'ios',
  device: simulator,
  app: 'net.siteed.farmslot.development',
  session: 'recorded-evidence-review-proof',
  stateDir: artifactsDir,
});
const context = {
  nodeId: 'report-review',
  artifactsDir,
  resolveArtifactPath: (relative: string) => path.join(artifactsDir, relative),
  registerArtifact: () => {},
} as ActionExecutionContext;
try {
  await transport.open();
  const { createAgentDeviceClient } = await import('agent-device');
  const client = createAgentDeviceClient({
    session: 'recorded-evidence-review-proof',
    stateDir: artifactsDir,
  });
  const initial = await client.capture.snapshot({
    platform: 'ios',
    target: 'mobile',
    udid: simulator,
    session: 'recorded-evidence-review-proof',
    forceFull: true,
  });
  if (initial.nodes.some((node) => node.label === 'Close document'))
    await transport.execute('ui.press', { text: 'Close document' }, context);
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    simulator,
    `farmslot-development://decision/${decision.id}?runId=${run.id}`,
  ]);
  await transport.execute(
    'ui.wait_for',
    { test_id: 'companion-output-report', timeout_ms: 10_000 },
    context,
  );
  const response = await fetch(
    `http://127.0.0.1:${process.env.METRO_PORT}/farmslot-recipe/command`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'hud',
        nodeId: context.nodeId,
        payload: {
          intent: 'Read the captured QA report and its case evidence.',
          status: 'running',
        },
        timeout_ms: 4000,
      }),
    },
  );
  assert((await response.json()).ok);
  await transport.execute(
    'ui.press',
    { test_id: 'companion-output-report', timeout_ms: 10_000 },
    context,
  );
  await transport.execute(
    'ui.wait_for',
    { text_contains: ['Recipe output'], timeout_ms: 10_000 },
    context,
  );
  await transport.execute(
    'ui.screenshot',
    { path: 'verified-report.png', label: 'Captured QA report and case evidence.' },
    context,
  );
  await transport.execute(
    'ui.press',
    { test_id: 'companion-ac-clip-case-1', timeout_ms: 10_000 },
    context,
  );
  await transport.execute('ui.press', { text: 'Next', timeout_ms: 10_000 }, context);
  await transport.execute(
    'ui.screenshot',
    { path: 'next-original.png', label: 'Next original retains proof playback bounds.' },
    context,
  );
  // Pressing a loaded marker must succeed; a zero decoder duration disables it.
  await transport.execute(
    'ui.press',
    { test_id: 'evidence-marker-1', timeout_ms: 10_000 },
    context,
  );
  await transport.execute(
    'ui.screenshot',
    { path: 'loaded-marker.png', label: 'Loaded proof marker on the native player.' },
    context,
  );
  const receipt = {
    pass: true,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runId: run.id,
    decisionId: decision.id,
    manifestDigest: decision.payload.manifestDigest,
    realNativeControls: true,
    copiedReader: false,
    loadedMarkerPressed: true,
    nextOriginal: true,
  };
  await fs.writeFile(path.join(artifactsDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  await transport.close();
}
