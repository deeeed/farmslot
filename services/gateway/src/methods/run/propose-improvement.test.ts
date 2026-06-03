import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { createRun, deleteRun, updateRun } from '../../runs/store.js';

import {
  __setImprovementAnalyzerForTest,
  composeImprovementAnalysisContent,
  runProposeImprovement,
} from './propose-improvement.js';

function createTempRunWithTask(learnings: string | null): { run: Run; taskDir: string } {
  const tmp = mkdtempSync(path.join(tmpdir(), 'farmslot-propose-test-'));
  const taskDir = path.join(tmp, 'tasks', 'PROJ-propose');
  mkdirSync(taskDir, { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# task\n', 'utf-8');
  if (learnings !== null) {
    const artifactsDir = path.join(taskDir, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, 'learnings.md'), learnings, 'utf-8');
  }
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  updateRun(run.id, { taskFile });
  return { run, taskDir: tmp };
}

async function cleanupProposeRun(runId: string, tmp: string): Promise<void> {
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
  rmSync(tmp, { recursive: true, force: true });
}

test('runProposeImprovement throws when run has no taskFile', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-no-task`,
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  await assert.rejects(() => runProposeImprovement({ runId: run.id }, () => {}), /has no taskFile/);
});

test('runProposeImprovement throws when learnings.md is empty', async (t) => {
  const { run, taskDir } = createTempRunWithTask('   \n\n  ');
  t.after(() => cleanupProposeRun(run.id, taskDir));

  await assert.rejects(
    () => runProposeImprovement({ runId: run.id }, () => {}),
    /no learnings\.md content/,
  );
});

test('runProposeImprovement throws when run is not found', async () => {
  await assert.rejects(
    () => runProposeImprovement({ runId: 'does-not-exist' }, () => {}),
    /Run not found/,
  );
});

test('runProposeImprovement fires analyzer with composed rationale + learnings', async (t) => {
  const learnings = 'Worker discovered xcrun path drifts on macOS 15.';
  const { run, taskDir } = createTempRunWithTask(learnings);

  const captured: Array<{ runId: string; content: string }> = [];
  let resolveAnalyzer!: () => void;
  const analyzerDone = new Promise<void>((res) => {
    resolveAnalyzer = res;
  });
  __setImprovementAnalyzerForTest(async (runId, content) => {
    captured.push({ runId, content });
    resolveAnalyzer();
  });

  t.after(async () => {
    __setImprovementAnalyzerForTest(null);
    await cleanupProposeRun(run.id, taskDir);
  });

  const result = await runProposeImprovement(
    { runId: run.id, rationale: 'Recipe missed the xcrun drift case.' },
    () => {},
  );
  assert.deepEqual(result, { ok: true });

  await analyzerDone;
  assert.equal(captured.length, 1, 'analyzer was never invoked');
  assert.equal(captured[0].runId, run.id);
  assert.match(captured[0].content, /## Human rationale\nRecipe missed the xcrun drift case\./);
  assert.match(
    captured[0].content,
    /## Worker learnings\nWorker discovered xcrun path drifts on macOS 15\./,
  );
});

test('composeImprovementAnalysisContent omits rationale section when absent', () => {
  const out = composeImprovementAnalysisContent(undefined, 'bare learnings');
  assert.equal(out, '## Worker learnings\nbare learnings');

  const outBlank = composeImprovementAnalysisContent('   ', 'bare learnings');
  assert.equal(outBlank, '## Worker learnings\nbare learnings');
});
