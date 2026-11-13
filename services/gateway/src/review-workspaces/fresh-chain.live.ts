// Opt-in task-input proof. Slow bundle materialization stays outside default CI.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { comparisonReviewContext } from '../review/comparison-context.js';
import {
  buildRepeatReviewContext,
  findLatestPriorReviewRun,
} from '../run-engine/engine-decisions.js';

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

test('comparison task inputs omit an unrequested reference review', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    f.run.ticketOrPr = `${f.subject.repository}#1`;
    const prior: Run = {
      ...structuredClone(f.run),
      id: 'reference-review',
      status: 'done',
      repeatReviewContext: undefined,
      reviewResult: {
        recommendation: 'REQUEST_CHANGES',
        reviewMd: 'Reference review result',
        lineComments: [
          { path: 'src/file.ts', line: 1, body: 'Reference finding', severity: 'major' },
        ],
        reviewSnapshot: {
          source: 'github-pr',
          headSha: f.subject.headSha,
          capturedAt: f.subject.capturedAt,
        },
      },
    };
    f.run.lane = 'comparison';
    f.run.variant = 'candidate';
    f.run.reviewMode = 'cold';
    f.run.reviewContext = undefined;
    f.run.reviewContext = comparisonReviewContext(f.run);
    f.run.repeatReviewContext = undefined;
    const selected = findLatestPriorReviewRun(f.run, [prior]);
    if (selected)
      f.run.repeatReviewContext = buildRepeatReviewContext(
        f.run,
        selected,
        {
          project: f.run.project,
          repository: f.subject.repository,
          prNumber: 1,
          headSha: f.subject.headSha,
        },
        [prior],
      );
    const created = await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    await assert.rejects(readFile(path.join(f.task, 'inputs/prior-review.json')), {
      code: 'ENOENT',
    });
    assert.doesNotMatch(
      await readFile(created.taskFile, 'utf8'),
      /Previous review:|prior-review\.json/,
    );
    const output = process.env.FARMSLOT_FRESH_CHAIN_MATERIALIZATION_OUT;
    if (output) {
      const existing = JSON.parse(await readFile(output, 'utf8'));
      await writeFile(
        output,
        JSON.stringify({ ...existing, comparisonInputsOmitted: true }) + '\n',
      );
    }
  });
});
