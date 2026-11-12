import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

let currentRunId = '';
const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: { ...core, readSlotField: async () => currentRunId },
});
const config = await import('../core/config.js');
const { makeVars } = await import('../runners/test-fixtures.js');
let enabled = false;
let slotReads = 0;
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({ projectJson: { review: enabled ? { enabled: true } : false } }),
    loadSlotVars: async () => {
      slotReads++;
      return makeVars();
    },
  },
});
const registry = await import('../runners/registry.js');
const resolved: Array<{ runner: string | null | undefined; model: string | null | undefined }> = [];
const stopBeforeLaunch = new Error('Synthetic test stops at reviewer selection');
mock.module('../runners/registry.js', {
  namedExports: {
    ...registry,
    runnerSupportsModel: (runner: string | null | undefined, model: string | null | undefined) => {
      resolved.push({ runner, model });
      throw stopBeforeLaunch;
    },
  },
});
const { executeReview } = await import('../review/orchestrator.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
const { firstOutputFixture } = await import('./first-output.test-support.js');
const { freezeEvalFirstOutputPackage } = await import('./package-store.js');

for (const reviewEnabled of [false, true]) {
  test(`eval judge honors persisted reviewer and review:false (enabled=${reviewEnabled})`, async (t) => {
    enabled = reviewEnabled;
    slotReads = 0;
    resolved.length = 0;
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-reviewer-config-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = createRun({
      project: 'synthetic-review-config',
      flowType: 'fix-bug',
      ticketOrPr: 'EVAL-CONFIG',
      mode: 'autonomous',
      slotId: 'synthetic-slot',
      completionPolicy: 'artifact-only',
    });
    currentRunId = run.id;
    t.after(() => deleteTestRunIfPresent(run.id));
    const fixture = await firstOutputFixture(root, getRun(run.id)!);
    Object.assign(fixture.engineState!.evalExperiment!, {
      reviewRunner: 'pi',
      reviewModel: 'litellm/claude-sonnet-5-5',
    });
    await freezeEvalFirstOutputPackage(fixture, {});
    updateRun(run.id, { engineState: fixture.engineState, taskFile: fixture.taskFile });
    if (reviewEnabled) {
      // Re-enter through the public orchestrator, as retries and resumes do.
      for (let attempt = 0; attempt < 2; attempt++)
        await assert.rejects(
          executeReview(run.id, 'synthetic-slot'),
          (error) => error === stopBeforeLaunch,
        );
      assert.deepEqual(resolved, [
        { runner: 'pi', model: 'litellm/claude-sonnet-5-5' },
        { runner: 'pi', model: 'litellm/claude-sonnet-5-5' },
      ]);
    } else {
      assert.deepEqual(await executeReview(run.id, 'synthetic-slot'), {
        skipped: true,
        reason: 'disabled-for-project',
        retryCount: 0,
      });
      assert.equal(slotReads, 0, 'disabled judging must not reach slot or reviewer launch');
      assert.deepEqual(resolved, []);
    }
  });
}
