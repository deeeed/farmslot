// Replay only COMPLETE on an owned validation gateway's retained command run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = process.env.FARMSLOT_SCRIPTED_COMPLETION_RUN_ID;
const gateway = process.env.FARMSLOT_GATEWAY;
const expected = process.env.FARMSLOT_SCRIPTED_COMPLETION_EXPECT ?? 'complete';
assert.ok(runId && gateway, 'Set the retained run ID and isolated gateway URL');
assert.ok(['complete', 'unconfirmed'].includes(expected));

function rpc(method, params) {
  const response = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(root, 'packages/cli/src/entry.ts'),
        '--url',
        gateway,
        '--json',
        'rpc',
        method,
        JSON.stringify(params),
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  return response;
}
const hash = (text) => createHash('sha256').update(text).digest('hex');
const { run: before } = rpc('run.get', { runId });
assert.equal(before.scripted?.mode, 'command');
const primary = before.agentContexts.find((context) => context.role === 'primary');
assert.equal(primary.runner, 'scripted');
const dispatch = before.steps.find((step) => step.name === 'dispatch');
const monitor = before.steps.find((step) => step.name === 'monitor');
assert.equal(dispatch.status, 'done');
assert.equal(monitor.status, 'done');
assert.equal(monitor.outputs.workerSignal.outcome, 'success');
assert.equal(before.steps.find((step) => step.name === 'complete').status, 'failed');
const directory = path.posix.dirname(primary.taskFile);
const artifactPaths = [
  path.posix.join(directory, 'artifacts/scripted-command-result.json'),
  path.posix.join(directory, 'artifacts/scripted-runner-provenance.json'),
  primary.signalFile,
];
const artifactHashes = () =>
  Object.fromEntries(
    artifactPaths.map((file) => [
      file,
      hash(rpc('fs.read', { slotId: before.slotId, path: file }).content),
    ]),
  );
const hashes = artifactHashes();
const replay = rpc('run.replayStep', { runId, stepName: 'complete', triggeredBy: 'operator' });
assert.equal(replay.run.id, runId);
let after;
const deadline = Date.now() + 60_000;
do {
  ({ run: after } = rpc('run.get', { runId }));
  if (['done', 'failed'].includes(after.steps.find((step) => step.name === 'complete')?.status))
    break;
  await new Promise((resolve) => setTimeout(resolve, 100));
} while (Date.now() < deadline);
assert.deepEqual(
  after.steps.find((step) => step.name === 'dispatch'),
  dispatch,
  'Never redispatch',
);
assert.deepEqual(
  after.steps.find((step) => step.name === 'monitor'),
  monitor,
  'Never rerun QA',
);
assert.deepEqual(artifactHashes(), hashes, 'Original command receipts must remain unchanged');
const complete = after.steps.find((step) => step.name === 'complete');
if (expected === 'complete') {
  assert.equal(complete.status, 'done', after.error);
  assert.equal(after.status, 'done');
} else {
  assert.equal(complete.status, 'failed');
  assert.equal(after.status, 'reconciling');
  assert.ok(JSON.stringify(after).includes('run-progress-unconfirmed'));
}
const receipt = {
  pass: true,
  expected,
  runId,
  status: after.status,
  complete,
  hashes,
  workerUnchanged: true,
};
if (process.env.FARMSLOT_SCRIPTED_COMPLETION_OUT) {
  writeFileSync(
    process.env.FARMSLOT_SCRIPTED_COMPLETION_OUT,
    JSON.stringify({ receipt, before, after }, null, 2) + '\n',
  );
}
console.log(JSON.stringify(receipt, null, 2));
