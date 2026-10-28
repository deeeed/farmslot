// Run on the gateway host with an explicit automation profile. Reads only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GatewayClient } from '../../../packages/cli/src/gateway-client.ts';
import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const output = path.resolve(process.argv[2]);
await mkdir(output, { recursive: false, mode: 0o700 });
const target = await automationGatewayTarget();
assert(target, 'Select an explicit authenticated automation profile');
const client = new GatewayClient({
  url: target.url,
  credential: target.credential,
  timeout: 15_000,
});
const connection = await client.connect();
const reads = [];
try {
  for (let call = 1; call <= 3; call++) {
    const loadBefore = os.loadavg();
    const start = performance.now();
    const { fleet } = await connection.call('fleet.status', {});
    reads.push({
      call,
      ms: performance.now() - start,
      loadBefore,
      loadAfter: os.loadavg(),
      checkedAt: fleet.checkedAt,
      slots: fleet.slots.length,
      observations: fleet.slots.map((slot) => ({
        slot: slot.slot,
        epoch: slot.slotEpoch,
        currentRunId: slot.currentRunId,
        observedAt: slot.workspace?.observedAt ?? null,
        error: Boolean(slot.workspaceError || slot.workspace?.error),
      })),
    });
    await writeFile(path.join(output, 'reads.json'), JSON.stringify(reads, null, 2) + '\n');
  }
  assert(
    reads.every((read) => read.slots > 0),
    'Require actual saved fleet rows',
  );
  assert(
    reads.every((read) => read.ms < 2_000),
    'Each status read must return within two seconds',
  );
  const result = {
    status: 'PASS',
    host: os.hostname(),
    reads: reads.map((read) => ({ ms: read.ms, load: read.loadBefore, slots: read.slots })),
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  connection.close();
}
