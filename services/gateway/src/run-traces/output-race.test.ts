import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { mock } from 'node:test';

// The slot read for a working tree is held until the committed output has been recorded.
let releaseRead!: () => void;
const readHeld = new Promise<void>((resolve) => (releaseRead = resolve));
const diff = Buffer.from('diff --git a/x b/x\n+working tree\n');
const readCommand = await import('../host-services/read-command.js');
mock.module('../host-services/read-command.js', {
  namedExports: {
    ...readCommand,
    readSlotCommand: async () => {
      await readHeld;
      return {
        exitCode: 0,
        stderr: '',
        stdout: `${'a'.repeat(40)}\n${diff.byteLength}\n${createHash('sha256').update(diff).digest('hex')}\n--farmslot-graded-diff--\n${diff.toString('base64')}\n`,
      };
    },
  },
});
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { recordGradedOutput } = await import('./output.js');
const { makeVars } = await import('../runners/test-fixtures.js');

test('a working-tree read that started before finalize never replaces the committed output', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `RACE-${Date.now()}`,
  });
  updateRun(run.id, { worktreeHeadAtDispatch: 'b'.repeat(40) });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const release = recordGradedOutput({
    runId: run.id,
    vars: makeVars(),
    source: 'working-tree',
    ref: null,
  });
  const committed = {
    diffSha256: 'c'.repeat(64),
    source: 'committed' as const,
    ref: 'd'.repeat(40),
    sizeBytes: 10,
    recordedAt: new Date().toISOString(),
  };
  updateRun(run.id, { gradedOutput: committed });
  releaseRead();
  await release;
  assert.deepEqual(getRun(run.id)!.gradedOutput, committed);
});
