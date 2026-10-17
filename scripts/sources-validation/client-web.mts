import { testGatewayProfile } from '../lib/test-gateway-identity-source.mjs';
/** Manual Command Center diagnostic proof through the committed CDP helper. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readSourceProofConnection } from './client-connection.js';

const execute = promisify(execFile);
const root = path.resolve(process.argv[2]);
const webPort = Number(process.argv[3]);
assert(webPort > 1024 && webPort < 65536);
const connection = await readSourceProofConnection(root);
const code = fileURLToPath(new URL('../../', import.meta.url));
const helper = path.join(code, 'apps/command-center/scripts/cdp.mjs');
const hash = `config/settings?source-proof=${path.basename(root)}`;
const route = `http://127.0.0.1:${webPort}/#${hash}`;
testGatewayProfile(path.join(root, 'home'), `ws://127.0.0.1:${connection.port}`, connection.token);
const env = {
  ...process.env,
  FARMSLOT_CDP_PORT: process.env.FARMSLOT_CDP_PORT ?? '19223',
  FARMSLOT_UI_URL: `http://127.0.0.1:${webPort}`,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_GATEWAY: `ws://127.0.0.1:${connection.port}`,
  FARMSLOT_GATEWAY_PROFILE: 'proof',
  FARMSLOT_GATEWAY_PASSWORD: '',
  SOURCE_PROOF_ROOT: root,
};
const cdp = async (...args: string[]) => {
  const result = await execute(process.execPath, [helper, ...args], { cwd: code, env });
  return result.stdout;
};
interface RenderedSourcePanel {
  text: string;
  line?: string;
  inputs: Array<{ disabled: boolean }>;
  buttons: Array<{ id: string; disabled: boolean }>;
  statusErrors: string[];
  operationErrors: string[];
}
const panels = async () =>
  JSON.parse(
    await cdp(
      'eval',
      hash,
      '--file',
      path.join(code, 'scripts/sources-validation/probes/source-panel.js'),
    ),
  ) as RenderedSourcePanel[];
const wait = async (ready: (panel: RenderedSourcePanel) => boolean) => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const current = (await panels())[0];
    if (current && ready(current)) return current;
    if (Date.now() > deadline)
      throw new Error('Source panel did not reach the required rendered state');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
const scenario = async (action: string) =>
  execute(
    process.execPath,
    ['--import', 'tsx', path.join(code, 'scripts/sources-validation/client-scenarios.mts'), action],
    { cwd: code, env },
  );
await cdp('goto', route, '--new');
try {
  const initial = await wait((panel) => panel.inputs.length > 0 && !panel.inputs[0].disabled);
  await scenario('arm-web-partial');
  await cdp('click', hash, '[data-testid="source-proof-pack-sync"]');
  const partial = await wait(
    (panel) =>
      panel.operationErrors.some((message) => message.includes('disconnected')) &&
      panel.text.includes('completed with errors'),
  );
  await scenario('assert-web-partial');
  // The recovered node's reconnect advances the source revision; no Refresh exists.
  const refreshed = await wait(
    (panel) =>
      panel.statusErrors.length === 0 &&
      panel.inputs.length > 0 &&
      !panel.inputs[0].disabled &&
      panel.operationErrors.some((message) => message.includes('disconnected')),
  );
  const screenshot = path.join(root, 'web-partial-sync.png');
  await cdp('screenshot', hash, screenshot);
  await writeFile(
    path.join(root, 'web-delta-evidence.json'),
    JSON.stringify({ result: 'PASS', initial, partial, refreshed, screenshot }, null, 2) + '\n',
  );
  console.log('Command Center partial-sync diagnostics PASS after recovery and live reread');
} finally {
  await cdp('close', hash);
}
