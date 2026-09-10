import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import type { PRWatchResult } from '../packages/protocol/src/index.js';

const id = process.env.RESUME_MONITOR_ID;
const file = process.env.RESUME_STATE_FILE;
assert(id && file, 'Supply RESUME_MONITOR_ID and a private RESUME_STATE_FILE');
const connection = await new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120000,
}).connect();
try {
  const { monitor } = await connection.call<PRWatchResult>('prWatch.get', { id });
  assert.equal(monitor.config.policy.mode, 'notify-only');
  if (process.argv[2] === 'before') {
    assert.equal(monitor.lifecycle, 'finished');
    await writeFile(file, JSON.stringify(monitor), { mode: 0o600 });
  } else {
    const before = JSON.parse(await readFile(file, 'utf8')) as PRWatchResult['monitor'];
    assert.equal(monitor.id, before.id);
    assert(
      (monitor.observationGeneration ?? 0) > (before.observationGeneration ?? 0),
      'Finished monitor must accept a real lifecycle transition',
    );
    assert.deepEqual(
      (monitor.repairs ?? []).map((repair) => repair.id),
      (before.repairs ?? []).map((repair) => repair.id),
      'Resuming a notify-only monitor must preserve repair history without adding work',
    );
    assert(monitor.lifecycle === 'active' || monitor.lifecycle === 'finished');
    console.log(
      JSON.stringify({
        passed: true,
        monitorId: id,
        lifecycle: monitor.lifecycle,
        explicitResumeAccepted: true,
        repairs: monitor.repairs?.length ?? 0,
      }),
    );
  }
} finally {
  connection.close();
}
