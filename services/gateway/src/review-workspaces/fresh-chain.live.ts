// Opt-in task-input proof. Slow bundle materialization stays outside default CI.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { materializeReviewWorkspaceTask } from './task.js';
import { withReviewWorkspaceTaskFixture } from './task-fixture.test-support.js';

test('a fresh review chain omits previous-review instructions and input files', async () => {
  await withReviewWorkspaceTaskFixture(async (fixture) => {
    fixture.run.repeatReviewContext = undefined;
    fixture.run.reviewContext = { freshChain: true, reviewLineages: [null] };
    fixture.run.reviewMode = 'cold';
    const task = await materializeReviewWorkspaceTask(
      fixture.run.id,
      fixture.subject,
      fixture.deps,
    );
    const text = await readFile(task.taskFile, 'utf8');
    assert.doesNotMatch(text, /Previous review:|prior-review\.json/);
    await assert.rejects(readFile(path.join(fixture.task, 'inputs/prior-review.json')), {
      code: 'ENOENT',
    });
    assert.equal(fixture.run.repeatReviewContext, undefined);
    const output = process.env.FARMSLOT_FRESH_CHAIN_MATERIALIZATION_OUT;
    if (output)
      await writeFile(
        output,
        JSON.stringify({
          pass: true,
          priorReviewInput: false,
          priorReviewInstruction: false,
          modelCalls: 0,
        }) + '\n',
      );
  });
});
