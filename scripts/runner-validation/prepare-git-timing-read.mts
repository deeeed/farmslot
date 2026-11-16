import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { isRecord, type RunGetResult } from '../../packages/protocol/src/index.js';
import { GatewayClient } from '../../packages/cli/src/gateway-client.js';
import { automationGatewayTarget } from '../lib/gateway-profile.mjs';

const runId = process.env.FARMSLOT_PREPARE_PROOF_RUN;
assert(runId, 'Set FARMSLOT_PREPARE_PROOF_RUN to the real run to observe');
const target = await automationGatewayTarget();
assert(target, 'Select an explicit authenticated gateway profile');
const client = await new GatewayClient({ ...target, timeout: 30_000 }).connect();
try {
  const { run } = await client.call<RunGetResult>('run.get', { runId, view: 'snapshot' });
  const prepare = run.steps.find((step) => step.name === 'prepare');
  const expectedStatus = process.env.FARMSLOT_PREPARE_PROOF_ACTIVE === '1' ? 'running' : 'done';
  assert.equal(prepare?.status, expectedStatus, 'Observe the selected real prepare phase');
  const rows = prepare?.outputs?.subSteps;
  assert(Array.isArray(rows), 'Prepare has no retained substeps');
  const timings = rows.filter(isRecord).filter((row) => /^git\.\d+\./.test(String(row.name)));
  assert(timings.length, 'Prepare has no Git timing records; instrumentation is not proven');
  assert(
    timings.every((row) => row.detail !== prepare?.detail),
    'Timing measurements must not replace the human stage detail',
  );
  const commands = timings.map((row) => {
    assert(typeof row.detail === 'string');
    const detail: unknown = JSON.parse(row.detail);
    assert(isRecord(detail));
    assert(typeof detail.operation === 'string');
    assert(detail.scope === 'command' || detail.scope === 'guarded-mutation');
    assert(typeof row.durationMs === 'number' && Number.isFinite(row.durationMs));
    assert(row.durationMs >= 0 && detail.durationMs === row.durationMs);
    assert(detail.exitCode === null || Number.isInteger(detail.exitCode));
    assert.equal(row.outcome, detail.exitCode === 0 ? 'ok' : 'failed');
    return { name: row.name, ...detail };
  });
  const receipt = {
    status: 'pass',
    runId: run.id,
    slotId: run.slotId,
    prepareStatus: prepare?.status,
    startedAt: prepare?.startedAt,
    completedAt: prepare?.completedAt,
    commands,
    note: 'Nested measurements include guarded-mutation parking. Do not sum with parent phases.',
  };
  const text = JSON.stringify(receipt, null, 2) + '\n';
  if (process.env.FARMSLOT_PREPARE_PROOF_OUTPUT)
    await writeFile(process.env.FARMSLOT_PREPARE_PROOF_OUTPUT, text);
  console.log(text);
} finally {
  client.close();
}
