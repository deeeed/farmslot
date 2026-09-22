// Read-only proof that a monitor resume accepts the worker's original completion.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runId = process.env.FARMSLOT_SIGNAL_PROOF_RUN_ID;
const expectedHash = process.env.FARMSLOT_SIGNAL_PROOF_SHA256;
assert.ok(runId && expectedHash, 'Set the recovered run ID and original signal SHA256');
function rpc(method, params) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}
const { run } = rpc('run.get', { runId });
const probe = rpc('run.probeWorkerSignal', { runId });
assert.equal(probe.ok, true, probe.message);
assert.equal(probe.code, 'ready');
const context = run.agentContexts.find((entry) => entry.id === probe.signal.contextId);
assert.equal(probe.signal.attemptId, context.signalAttemptId);
assert.ok(context.signalAttemptId);
assert.ok(
  Date.parse(probe.signal.timestamp) < Date.parse(run.monitorState.startedAt),
  'This proof requires completion before the monitor was resumed',
);
const { content } = rpc('fs.read', { slotId: run.slotId, path: probe.signalFile });
const hash = createHash('sha256').update(content).digest('hex');
assert.equal(hash, expectedHash, 'Recovery must not rewrite the original signal');
console.log(
  JSON.stringify({
    runId,
    status: run.status,
    signalAccepted: probe.ok,
    attemptId: context.signalAttemptId,
    signalSha256: hash,
  }),
);
