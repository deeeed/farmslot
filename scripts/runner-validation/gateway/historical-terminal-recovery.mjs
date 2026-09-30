import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cdp = fileURLToPath(new URL('../../../apps/command-center/scripts/cdp.mjs', import.meta.url));
const runId = process.env.FARMSLOT_TERMINAL_PROOF_RUN_ID;
assert.ok(
  runId,
  'Set FARMSLOT_TERMINAL_PROOF_RUN_ID to a historical run with a missing worker window',
);

async function rpc(method, params) {
  try {
    const { stdout } = await execute(
      process.execPath,
      [cdp, 'gateway', method, JSON.stringify(params)],
      {
        env: {
          ...process.env,
          FARMSLOT_RPC_TIMEOUT_MS: process.env.FARMSLOT_RPC_TIMEOUT_MS ?? '30000',
        },
      },
    );
    return { ok: true, payload: JSON.parse(stdout) };
  } catch (error) {
    // The committed RPC client writes structured gateway failures with this prefix.
    const prefix = 'cdp.mjs: ';
    if (typeof error.stderr !== 'string' || !error.stderr.startsWith(`${prefix}{`)) throw error;
    const frame = JSON.parse(error.stderr.slice(prefix.length));
    assert.equal(frame.type, 'res');
    assert.equal(frame.ok, false);
    return frame;
  }
}

// Metadata-only lookup keeps terminal validation independent of artifact mirroring.
const loaded = await rpc('run.list', {
  familyId: process.env.FARMSLOT_TERMINAL_PROOF_FAMILY_ID ?? runId,
});
assert.equal(loaded.ok, true);
const run = loaded.payload.runs.find((candidate) => candidate.id === runId);
assert.ok(
  run,
  'Run not found in its family; set FARMSLOT_TERMINAL_PROOF_FAMILY_ID for a child run',
);
assert.ok(['done', 'failed', 'cancelled'].includes(run.status), 'Use a terminal run');
const fleet = await rpc('fleet.status', {});
assert.equal(fleet.ok, true);
const slot = fleet.payload.fleet.slots.find((candidate) => candidate.slot === run.slotId);
assert.ok(
  slot?.lifecycle === 'ready' && slot.agent === 'idle' && !slot.currentRunId,
  'Use an unbound idle slot; this proof opens its current terminal',
);
const contextId = process.env.FARMSLOT_TERMINAL_PROOF_CONTEXT_ID;
assert.ok(contextId, 'Set FARMSLOT_TERMINAL_PROOF_CONTEXT_ID to the missing worker window');
const context = run.agentContexts.find((candidate) => candidate.id === contextId);
assert.ok(context?.target, 'Select a retired tmux worker context');

const retired = await rpc('terminal.subscribe', {
  slotId: run.slotId,
  runId,
  contextId: context.id,
  role: context.role,
  interactive: true,
});
assert.equal(retired.ok, false);
assert.equal(retired.error.code, 'TERMINAL_TARGET_RETIRED');

const removedContext = await rpc('terminal.subscribe', {
  slotId: run.slotId,
  runId,
  contextId: 'fs-terminal-proof-removed-context',
  interactive: true,
});
assert.equal(removedContext.ok, false);
assert.equal(removedContext.error.code, 'TERMINAL_TARGET_RETIRED');

const removedRun = await rpc('terminal.subscribe', {
  slotId: run.slotId,
  runId: randomUUID(),
  contextId: context.id,
  interactive: true,
});
assert.equal(removedRun.ok, false);
assert.equal(removedRun.error.code, 'TERMINAL_TARGET_RETIRED');

const pending = await rpc('terminal.subscribe', {
  slotId: run.slotId,
  target: `${context.target.session}:fs-terminal-missing-proof`,
  interactive: true,
});
assert.equal(pending.ok, false);
assert.equal(pending.error.code, 'TERMINAL_TARGET_PENDING');

const shell = await rpc('terminal.subscribe', {
  slotId: run.slotId,
  bareSession: true,
  interactive: true,
});
assert.equal(shell.ok, true, 'Explicit bare-session attachment remains available');
console.log(
  JSON.stringify({
    runId,
    contextId: context.id,
    retired: retired.error.code,
    removedContext: removedContext.error.code,
    removedRun: removedRun.error.code,
    pending: pending.error.code,
    slotTerminalAttached: true,
  }),
);
