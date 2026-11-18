// Opt-in integration coverage: the real task materializer takes more than five seconds.
// NODE_TEST_CONTEXT=1 TSX_TSCONFIG_PATH=tsconfig.json node --import tsx src/review-workspaces/reference-checkouts.live.ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

assert.equal(process.env.NODE_TEST_CONTEXT, '1', 'Run this opt-in proof with NODE_TEST_CONTEXT=1');
const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'review-reference-proof-'));
const previousStatusFile = process.env.FARMSLOT_TEST_STATUS_FILE;
const statusFile = path.join(stateDirectory, 'status.json');
process.env.FARMSLOT_TEST_STATUS_FILE = statusFile;
after(async () => {
  if (previousStatusFile === undefined) delete process.env.FARMSLOT_TEST_STATUS_FILE;
  else process.env.FARMSLOT_TEST_STATUS_FILE = previousStatusFile;
  await rm(stateDirectory, { recursive: true, force: true });
});
await writeFile(statusFile, JSON.stringify({ slots: [] }));
const { materializeReviewWorkspaceTask } = await import('./task.js');
const { withReviewWorkspaceTaskFixture: withFixture } =
  await import('./task-fixture.test-support.js');

test('a review with no support bundle still names the references it cannot read', async () => {
  await withFixture(async (f) => {
    // No support binding at all: nothing read those checkouts, so every declared
    // read-only reference is unreadable here and has to say so.
    assert.equal(f.run.reviewWorkspace!.support, undefined);
    const result = await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    const task = await readFile(result.taskFile, 'utf8');
    assert.match(task, /### Reference checkouts \(read-only\)/);
    assert.match(task, /- `mobile`: not readable from this task/);
    assert.match(task, /- `core`: not readable from this task/);
    assert.match(task, /BLOCKED, never NOT_CHECKED/);
    assert.doesNotMatch(task, /`unplaced`/, 'the slot’s own checkout is not a reference');
    assert.deepEqual(
      JSON.parse(await readFile(path.join(f.task, 'inputs/reference-checkouts.json'), 'utf8')),
      {
        schemaVersion: 1,
        references: [
          { name: 'mobile', path: '', present: false },
          { name: 'core', path: '', present: false },
          { name: 'extension', path: '', present: false },
        ],
      },
    );
  });
});
