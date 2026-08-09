import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import type { ImprovementDiffPayload, Run } from '@farmslot/protocol';

import { __setLearningsClassifierForTest } from '../../intelligence/learnings-router.js';
import { createRun, deleteRun, getRun, runRecordPath, updateRun } from '../../runs/store.js';

import {
  __setImprovementAnalyzerForTest,
  composeImprovementAnalysisContent,
  resumeInterruptedImprovementAnalyses,
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

// MANUAL-000075: analyses now route learnings through the system/domain
// classifier first. Pin every entry to `system` so these tests keep asserting
// the analyzer contract deterministically, without an LLM.
__setLearningsClassifierForTest(async (entries) => entries.map(() => 'system' as const));
after(() => __setLearningsClassifierForTest(null));

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

function seedAnalyzingPlaceholder(runId: string, attempts: number | undefined): string {
  const decisionId = `imp-${runId}-test`;
  const run = getRun(runId)!;
  updateRun(runId, {
    decisions: [
      ...(run.decisions ?? []),
      {
        id: decisionId,
        type: 'improvement',
        title: 'Analyzing learnings…',
        description: 'test placeholder',
        actions: [],
        createdAt: new Date().toISOString(),
        payload: {
          kind: 'improvement',
          learningContent: '',
          proposedChanges: [],
          rationale: '',
          sourceRunId: runId,
          project: 'example-mobile-farm',
          analysisStatus: 'analyzing',
          analysisStartedAt: new Date().toISOString(),
          ...(attempts !== undefined ? { analysisAttempts: attempts } : {}),
        },
      } as Run['decisions'][number],
    ],
  });
  return decisionId;
}

function improvementPayload(runId: string, decisionId: string): ImprovementDiffPayload {
  const decision = getRun(runId)!.decisions.find((d) => d.id === decisionId)!;
  return decision.payload as ImprovementDiffPayload;
}

test('resume re-runs an interrupted analysis on the same placeholder and persists the attempt bump', async (t) => {
  const { run, taskDir } = createTempRunWithTask('Interrupted-run learning bullet.');
  const decisionId = seedAnalyzingPlaceholder(run.id, 1);

  const captured: Array<{ runId: string; content: string; placeholderId?: string }> = [];
  let resolveAnalyzer!: () => void;
  const analyzerDone = new Promise<void>((res) => {
    resolveAnalyzer = res;
  });
  __setImprovementAnalyzerForTest(async (runId, content, placeholderId) => {
    captured.push({ runId, content, placeholderId });
    resolveAnalyzer();
  });
  t.after(async () => {
    __setImprovementAnalyzerForTest(null);
    await cleanupProposeRun(run.id, taskDir);
  });

  await resumeInterruptedImprovementAnalyses();
  await analyzerDone;

  assert.equal(captured.length, 1, 'analyzer was never invoked');
  assert.equal(captured[0].runId, run.id);
  assert.equal(captured[0].placeholderId, decisionId, 'must reuse the existing placeholder card');
  assert.match(captured[0].content, /Interrupted-run learning bullet\./);
  assert.equal(improvementPayload(run.id, decisionId).analysisAttempts, 2);
});

test('a resume of an all-domain run emits ONE draft card and never stacks duplicates', async (t) => {
  const { run, taskDir } = createTempRunWithTask('Product screens flake on slow seeds.');
  const decisionId = seedAnalyzingPlaceholder(run.id, 1);

  const { __setAntipatternDrafterForTest } = await import('../../intelligence/learnings-router.js');
  __setLearningsClassifierForTest(async (entries) => entries.map(() => 'domain' as const));
  // example-mobile-farm has no vars.antipattern_repo_key, so the domain entry
  // becomes a teaching hold — still exactly one learnings-draft card.
  __setImprovementAnalyzerForTest(async () => {
    assert.fail('analyzer must not run when nothing classifies system');
  });
  t.after(async () => {
    __setLearningsClassifierForTest(async (entries) => entries.map(() => 'system' as const));
    __setAntipatternDrafterForTest(null);
    __setImprovementAnalyzerForTest(null);
    await cleanupProposeRun(run.id, taskDir);
  });

  await resumeInterruptedImprovementAnalyses();
  // The routed no-system arm terminalizes the placeholder asynchronously; poll
  // the persisted decision instead of racing a fixed sleep.
  for (let i = 0; i < 100; i += 1) {
    if (improvementPayload(run.id, decisionId).analysisStatus === 'no-changes') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(improvementPayload(run.id, decisionId).analysisStatus, 'no-changes');

  const draftCards = () =>
    (getRun(run.id)?.decisions ?? []).filter((d) => d.type === 'engine_learnings_draft');
  assert.equal(draftCards().length, 1, 'exactly one learnings-draft card after resume');

  // A second interrupted resume (crash loop) must not stack another card.
  const payload = improvementPayload(run.id, decisionId);
  payload.analysisStatus = 'analyzing';
  payload.analysisAttempts = 1;
  updateRun(run.id, { decisions: getRun(run.id)!.decisions });
  await resumeInterruptedImprovementAnalyses();
  for (let i = 0; i < 100; i += 1) {
    if (improvementPayload(run.id, decisionId).analysisStatus === 'no-changes') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(draftCards().length, 1, 'crash-loop resume must not duplicate the draft card');
});

test('resume terminalizes a placeholder at the retry cap without re-running it', async (t) => {
  const { run, taskDir } = createTempRunWithTask('Learning that will not be re-analyzed.');
  const decisionId = seedAnalyzingPlaceholder(run.id, 2);

  __setImprovementAnalyzerForTest(async () => {
    assert.fail('analyzer must not run for a placeholder at the retry cap');
  });
  t.after(async () => {
    __setImprovementAnalyzerForTest(null);
    await cleanupProposeRun(run.id, taskDir);
  });

  await resumeInterruptedImprovementAnalyses();

  const payload = improvementPayload(run.id, decisionId);
  assert.equal(payload.analysisStatus, 'error');
  assert.match(payload.analysisError ?? '', /retry limit/);
  assert.equal(payload.analysisAttempts, 2, 'terminalization must preserve the attempt count');
});

test('resume treats a missing analysisAttempts as the first attempt (legacy placeholders)', async (t) => {
  const { run, taskDir } = createTempRunWithTask('Legacy placeholder learning.');
  const decisionId = seedAnalyzingPlaceholder(run.id, undefined);

  let resolveAnalyzer!: () => void;
  const analyzerDone = new Promise<void>((res) => {
    resolveAnalyzer = res;
  });
  __setImprovementAnalyzerForTest(async () => {
    resolveAnalyzer();
  });
  t.after(async () => {
    __setImprovementAnalyzerForTest(null);
    await cleanupProposeRun(run.id, taskDir);
  });

  await resumeInterruptedImprovementAnalyses();
  await analyzerDone;
  assert.equal(improvementPayload(run.id, decisionId).analysisAttempts, 2);
});

test('resume persists the attempt bump to disk before the analyzer starts', async (t) => {
  const { run, taskDir } = createTempRunWithTask('Durability learning bullet.');
  const decisionId = seedAnalyzingPlaceholder(run.id, 1);

  let attemptsOnDiskAtAnalyzerStart: number | undefined;
  let resolveAnalyzer!: () => void;
  const analyzerDone = new Promise<void>((res) => {
    resolveAnalyzer = res;
  });
  __setImprovementAnalyzerForTest(async (runId) => {
    const persisted = JSON.parse(readFileSync(runRecordPath(runId), 'utf-8')) as Run;
    const decision = persisted.decisions.find((d) => d.id === decisionId);
    attemptsOnDiskAtAnalyzerStart = (decision?.payload as ImprovementDiffPayload | undefined)
      ?.analysisAttempts;
    resolveAnalyzer();
  });
  t.after(async () => {
    __setImprovementAnalyzerForTest(null);
    await cleanupProposeRun(run.id, taskDir);
  });

  await resumeInterruptedImprovementAnalyses();
  await analyzerDone;

  assert.equal(
    attemptsOnDiskAtAnalyzerStart,
    2,
    'attempt bump must be durable on disk before analysis begins',
  );
});

test('a second resume while an analysis is in flight neither re-runs nor tombstones it', async (t) => {
  const { run, taskDir } = createTempRunWithTask('Idempotency learning bullet.');
  const decisionId = seedAnalyzingPlaceholder(run.id, 1);

  let invocations = 0;
  let releaseAnalyzer!: () => void;
  const analyzerGate = new Promise<void>((res) => {
    releaseAnalyzer = res;
  });
  let analyzerStarted!: () => void;
  const analyzerStartedGate = new Promise<void>((res) => {
    analyzerStarted = res;
  });
  __setImprovementAnalyzerForTest(async () => {
    invocations += 1;
    analyzerStarted();
    await analyzerGate;
  });
  t.after(async () => {
    __setImprovementAnalyzerForTest(null);
    releaseAnalyzer();
    await cleanupProposeRun(run.id, taskDir);
  });

  await resumeInterruptedImprovementAnalyses();
  await analyzerStartedGate;
  // Second sweep while the first analysis is still in flight: the placeholder
  // is still `analyzing` with attempts=2, which without the in-flight guard
  // would be mistaken for a crash loop and tombstoned at the cap.
  await resumeInterruptedImprovementAnalyses();

  assert.equal(invocations, 1, 'in-flight analysis must not be re-run');
  assert.equal(
    improvementPayload(run.id, decisionId).analysisStatus,
    'analyzing',
    'in-flight analysis must not be tombstoned at the cap',
  );
});

test('resume terminalizes as no-content when learnings vanished', async (t) => {
  const { run, taskDir } = createTempRunWithTask(null);
  const decisionId = seedAnalyzingPlaceholder(run.id, 1);

  __setImprovementAnalyzerForTest(async () => {
    assert.fail('analyzer must not run without learnings content');
  });
  t.after(async () => {
    __setImprovementAnalyzerForTest(null);
    await cleanupProposeRun(run.id, taskDir);
  });

  await resumeInterruptedImprovementAnalyses();
  // The no-content terminal happens in the fire-and-forget tail; poll briefly.
  for (let i = 0; i < 50; i++) {
    if (improvementPayload(run.id, decisionId).analysisStatus !== 'analyzing') break;
    await new Promise((res) => setTimeout(res, 20));
  }
  const payload = improvementPayload(run.id, decisionId);
  assert.equal(payload.analysisStatus, 'no-content');
});

test('composeImprovementAnalysisContent omits rationale section when absent', () => {
  const out = composeImprovementAnalysisContent(undefined, 'bare learnings');
  assert.equal(out, '## Worker learnings\nbare learnings');

  const outBlank = composeImprovementAnalysisContent('   ', 'bare learnings');
  assert.equal(outBlank, '## Worker learnings\nbare learnings');
});
