/** Read-only protocol assertions for the live source-picker recipe. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSourceCommandClient } from '@farmslot/protocol';
import { GatewayClient } from '../../packages/cli/src/gateway-client.js';
import { readSourceProofConnection } from './client-connection.js';

const root = process.env.SOURCE_PROOF_ROOT;
assert(root, 'SOURCE_PROOF_ROOT must identify the owned fleet proof');
const connection = await readSourceProofConnection(root);
const phase = process.argv[2];
if (phase === 'open-run' || phase === 'open-fleet') {
  const route = phase === 'open-run' ? `/run/${connection.runId}` : '/fleet';
  if (process.env.ANDROID_SERIAL)
    await promisify(execFile)('adb', [
      '-s',
      process.env.ANDROID_SERIAL,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      `farmslot-development://${route}`,
      'net.siteed.farmslot.development',
    ]);
  else {
    assert(process.env.IOS_SIMULATOR, 'IOS_SIMULATOR must identify the owned proof device');
    await promisify(execFile)('xcrun', [
      'simctl',
      'openurl',
      process.env.IOS_SIMULATOR,
      `farmslot-development://${route}`,
    ]);
  }
} else {
  assert(['web-pin', 'web-main', 'native-pin', 'native-main', 'native-invalid'].includes(phase));
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${connection.port}`,
    credential: { token: connection.token },
    timeout: 120_000,
  });
  const sources = createSourceCommandClient((method, params) => client.call(method, params));
  const expected = phase.endsWith('-pin') ? 'experiment/farm' : 'main';
  const deadline = Date.now() + 120_000;
  let status = await sources.status();
  while (status.effectiveSelections?.[0].effectiveRef !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await sources.status();
  }
  assert.equal(status.effectiveSelections?.[0].effectiveRef, expected);
  assert.equal(status.effectiveSelections?.[0].pin?.scope, 'farm');
  await writeFile(
    path.join(root, `${phase}.json`),
    JSON.stringify({ result: 'PASS', phase, status }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      result: 'PASS',
      phase,
      effectiveRef: expected,
      pinRevision: status.pinRevision,
    }),
  );
}
