import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateFamilyReport } from './report.js';
import { buildFamilyObservabilitySnapshotFromRuns } from './snapshot.js';
import { makeRun, writeArtifact } from './test-fixtures.js';

test('snapshot prefers family-level recipe quality from the strongest available signal and keeps a family-first summary', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-strength-'));
  const rootDir = path.join(base, 'root');
  const followUpDir = path.join(base, 'followup');
  await writeArtifact(rootDir, 'TASK.md', '# Root task');
  await writeArtifact(rootDir, 'artifacts/report.md', 'Root family narrative');
  await writeArtifact(
    rootDir,
    'artifacts/recipe.json',
    JSON.stringify({
      workflow: {
        entry: 'start',
        nodes: {
          start: { action: 'navigate', next: 'done' },
          done: { action: 'assert' },
        },
      },
    }),
  );
  await writeArtifact(
    rootDir,
    'artifacts/recipe-quality.json',
    JSON.stringify(
      {
        version: 1,
        verdict: 'pass',
        compact: {
          verdict: 'PASS',
          reasons: ['Family root recipe quality is strong.'],
          better_version_guidance: [],
        },
        dimensions: {},
        structural_findings: [],
        contextual_findings: [],
        suggested_recipe_delta: [],
        training_fields: {
          project: 'example-mobile-farm',
          flow_type: 'fix-bug',
          proof_mode: 'mixed',
        },
        meta: {
          producer: 'worker',
          fallback_used: false,
          legacy_task: false,
          artifact_required: true,
          source_signals: ['recipe-quality.json'],
        },
      },
      null,
      2,
    ),
  );
  await writeArtifact(followUpDir, 'TASK.md', '# Follow-up task');
  await writeArtifact(
    followUpDir,
    'artifacts/recipe.json',
    JSON.stringify({
      workflow: {
        entry: 'start',
        nodes: {
          start: { action: 'navigate', next: 'done' },
          done: { action: 'assert' },
        },
      },
    }),
  );
  await writeArtifact(followUpDir, 'artifacts/report.md', 'Latest tiny follow-up');

  const root = makeRun({
    id: 'root-run',
    familyId: 'family-strong',
    familyRootTicketOrPr: 'PROJ-77',
    ticketOrPr: 'PROJ-77',
    taskFile: path.join(rootDir, 'TASK.md'),
    summary: 'Root family narrative',
  });
  const followUp = makeRun({
    id: 'follow-up',
    familyId: 'family-strong',
    familyRootTicketOrPr: 'PROJ-77',
    parentRunId: 'root-run',
    ticketOrPr: 'owner/repo#77',
    flowType: 'pr-complete',
    taskFile: path.join(followUpDir, 'TASK.md'),
    summary: 'Tiny follow-up summary',
    updatedAt: '2026-04-15T02:00:00.000Z',
  });

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([root, followUp]);

  assert.equal(snapshot.recipeQuality.source, 'recipe-quality');
  assert.equal(snapshot.recipeQuality.semantic, 'good');
  assert.match(snapshot.summary, /Root family narrative/);
  assert.match(snapshot.summary, /latest follow-up: Tiny follow-up summary/);
});

test('snapshot recovers a missing family recipe from a unique historical run with the same PR and branch', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-provenance-'));
  const familyDir = path.join(base, 'family');
  const historicalDir = path.join(base, 'historical');

  await writeArtifact(familyDir, 'TASK.md', '# PR complete task');
  await writeArtifact(familyDir, 'artifacts/comments-report.md', 'Review comments handled.');
  await writeArtifact(historicalDir, 'TASK.md', '# Original task');
  await writeArtifact(historicalDir, 'artifacts/report.md', 'Original worker report');
  await writeArtifact(historicalDir, 'artifacts/learnings.md', 'Original worker learning');
  await writeArtifact(
    historicalDir,
    'artifacts/recipe.json',
    JSON.stringify({
      workflow: {
        entry: 'start',
        nodes: {
          start: { action: 'navigate', next: 'done' },
          done: { action: 'assert' },
        },
      },
    }),
  );
  await writeArtifact(
    historicalDir,
    'artifacts/recipe-quality.json',
    JSON.stringify(
      {
        version: 1,
        verdict: 'pass',
        compact: {
          verdict: 'PASS',
          reasons: ['Historical recipe is canonical.'],
          better_version_guidance: [],
        },
        dimensions: {},
        structural_findings: [],
        contextual_findings: [],
        suggested_recipe_delta: [],
        training_fields: {
          project: 'example-browser-farm',
          flow_type: 'fix-bug',
          proof_mode: 'mixed',
        },
        meta: {
          producer: 'worker',
          fallback_used: false,
          legacy_task: false,
          artifact_required: true,
          source_signals: ['recipe-quality.json'],
        },
      },
      null,
      2,
    ),
  );
  await writeArtifact(historicalDir, 'artifacts/after.mp4', 'video');

  const familyRun = makeRun({
    id: 'pr-complete-run',
    familyId: 'family-pr',
    familyRootTicketOrPr: 'example-org/example-browser#42009',
    ticketOrPr: 'example-org/example-browser#42009',
    project: 'example-browser-farm',
    flowType: 'pr-complete',
    prNumber: 42009,
    branch: 'feat/proj-2691-persist-perp-reopen-state',
    taskFile: path.join(familyDir, 'TASK.md'),
    slotId: 'runner-browser-1',
  });
  const historicalRun = makeRun({
    id: 'original-run',
    familyId: 'original-family',
    familyRootTicketOrPr: 'PROJ-2691',
    ticketOrPr: 'PROJ-2691',
    project: 'example-browser-farm',
    flowType: 'fix-bug',
    prNumber: 42009,
    branch: 'feat/proj-2691-persist-perp-reopen-state',
    taskFile: path.join(historicalDir, 'TASK.md'),
    slotId: 'runner-browser-1',
    updatedAt: '2026-04-14T00:00:00.000Z',
  });

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns(
    [familyRun],
    [familyRun, historicalRun],
  );
  const run = snapshot.runs[0];

  assert.equal(run.recipeJson?.includes('start'), true);
  assert.equal(run.recipeProvenance?.status, 'resolved');
  assert.equal(run.recipeProvenance?.sourceRunId, 'original-run');
  assert.equal(run.recipeProvenance?.sourceSlotId, 'runner-browser-1');
  // pr-complete now reads its own per-flow report (comments-report.md per
  // FLOW_WORKER_REPORT_ARTIFACTS) rather than falling through to historical
  // recovery — own evidence wins, recovery only fills genuinely missing data.
  assert.equal(run.workerReport, 'Review comments handled.');
  assert.equal(run.workerLearnings, 'Original worker learning');
  assert.equal(run.recipeQualityArtifact?.compact.verdict, 'PASS');
  assert.equal(run.missingData.includes('recipe-json'), false);
  assert.equal(run.missingData.includes('worker-report'), false);
  assert.equal(run.missingData.includes('worker-learnings'), false);
  assert.equal(snapshot.missingData.includes('family-recipe'), false);
  const recoveredArtifacts = run.artifacts.filter(
    (artifact) => artifact.source === 'recovered-provenance',
  );
  assert(recoveredArtifacts.length > 0);
  assert.equal(
    recoveredArtifacts.every(
      (artifact) => artifact.runId === 'original-run' && artifact.familyId === 'original-family',
    ),
    true,
  );
  assert.equal(
    snapshot.evidence.some(
      (artifact) => artifact.runId === 'original-run' && artifact.path === 'artifacts/after.mp4',
    ),
    true,
  );
  assert(snapshot.familyChangeLedger);
  assert.equal(
    snapshot.familyChangeLedger.summary.artifactFootprint.bySource.some(
      (bucket) =>
        bucket.key === 'recovered-provenance' && bucket.count === recoveredArtifacts.length,
    ),
    true,
  );
  assert.equal(
    snapshot.relatedByTicket.some((related) => related.runId === 'original-run'),
    true,
  );
});

test('snapshot relates eval families to historical bugfix runs by PR number', async () => {
  const replayRun = makeRun({
    id: 'candidate-run',
    familyId: 'eval-family',
    familyRootTicketOrPr: 'example-org/example-browser#42292',
    ticketOrPr: 'example-org/example-browser#42292',
    project: 'example-browser-farm',
    flowType: 'dev',
    lane: 'comparison',
    variant: 'eval-candidate',
    completionPolicy: 'artifact-only',
    prNumber: undefined,
    summary: 'Eval candidate for TP/SL rendering from a prior commit',
  });
  const historicalBugfixRun = makeRun({
    id: 'historical-bugfix-run',
    familyId: 'historical-bugfix-family',
    familyRootTicketOrPr: 'PROJ-3075',
    ticketOrPr: 'PROJ-3075',
    project: 'example-browser-farm',
    flowType: 'fix-bug',
    lane: 'production',
    prNumber: 42292,
    summary: 'Fix position TP/SL routing to auto-close section on market detail',
    updatedAt: '2026-04-30T12:50:52.555Z',
  });
  const unrelatedBugfixRun = makeRun({
    id: 'unrelated-bugfix-run',
    familyId: 'unrelated-bugfix-family',
    familyRootTicketOrPr: 'PROJ-9999',
    ticketOrPr: 'PROJ-9999',
    project: 'example-browser-farm',
    flowType: 'fix-bug',
    lane: 'production',
    prNumber: 9999,
  });

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns(
    [replayRun],
    [replayRun, historicalBugfixRun, unrelatedBugfixRun],
  );

  assert.deepEqual(
    snapshot.relatedByTicket.map((related) => related.runId),
    ['historical-bugfix-run'],
  );
  assert.equal(snapshot.relatedByTicket[0]?.flowType, 'fix-bug');
  assert.equal(snapshot.relatedByTicket[0]?.prNumber, 42292);
});

test('family artifact footprint dedupes recovered provenance across missing family runs', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-provenance-dedupe-'));
  const firstDir = path.join(base, 'first');
  const secondDir = path.join(base, 'second');
  const historicalDir = path.join(base, 'historical');

  await writeArtifact(firstDir, 'TASK.md', '# First follow-up');
  await writeArtifact(secondDir, 'TASK.md', '# Second follow-up');
  await writeArtifact(historicalDir, 'TASK.md', '# Original task');
  await writeArtifact(
    historicalDir,
    'artifacts/recipe.json',
    JSON.stringify({
      workflow: { entry: 'start', nodes: { start: { action: 'assert' } } },
    }),
  );
  await writeArtifact(historicalDir, 'artifacts/after.png', 'png');

  const firstRun = makeRun({
    id: 'first-run',
    familyId: 'family-recovered-dedupe',
    familyRootTicketOrPr: 'owner/repo#456',
    ticketOrPr: 'owner/repo#456',
    project: 'example-browser-farm',
    flowType: 'pr-complete',
    prNumber: 456,
    branch: 'fix/recovered-dedupe',
    taskFile: path.join(firstDir, 'TASK.md'),
    updatedAt: '2026-04-15T02:00:00.000Z',
  });
  const secondRun = makeRun({
    id: 'second-run',
    familyId: 'family-recovered-dedupe',
    familyRootTicketOrPr: 'owner/repo#456',
    ticketOrPr: 'owner/repo#456',
    project: 'example-browser-farm',
    flowType: 'pr-complete',
    prNumber: 456,
    branch: 'fix/recovered-dedupe',
    taskFile: path.join(secondDir, 'TASK.md'),
    updatedAt: '2026-04-15T03:00:00.000Z',
  });
  const historicalRun = makeRun({
    id: 'historical-run',
    familyId: 'historical-family',
    ticketOrPr: 'PROJ-456',
    project: 'example-browser-farm',
    prNumber: 456,
    branch: 'fix/recovered-dedupe',
    taskFile: path.join(historicalDir, 'TASK.md'),
    updatedAt: '2026-04-14T00:00:00.000Z',
  });

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns(
    [firstRun, secondRun],
    [firstRun, secondRun, historicalRun],
  );

  assert(snapshot.familyChangeLedger);
  const recovered = snapshot.runs.flatMap((run) =>
    run.artifacts.filter((artifact) => artifact.source === 'recovered-provenance'),
  );
  assert.equal(recovered.length > 0, true);
  assert.equal(
    recovered.every((artifact) => artifact.sourceRunId === 'historical-run'),
    true,
  );
  const recoveredBucket = snapshot.familyChangeLedger.summary.artifactFootprint.bySource.find(
    (bucket) => bucket.key === 'recovered-provenance',
  );
  assert(recoveredBucket);
  assert.equal(recoveredBucket.count, recovered.length / 2);
});

test('snapshot leaves recipe missing when historical recipe provenance is ambiguous', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-provenance-ambiguous-'));
  const familyDir = path.join(base, 'family');
  const candidateOneDir = path.join(base, 'candidate-one');
  const candidateTwoDir = path.join(base, 'candidate-two');

  await writeArtifact(familyDir, 'TASK.md', '# PR complete task');
  await writeArtifact(candidateOneDir, 'TASK.md', '# Candidate one');
  await writeArtifact(candidateOneDir, 'artifacts/recipe.json', '{"entry":"one"}');
  await writeArtifact(candidateTwoDir, 'TASK.md', '# Candidate two');
  await writeArtifact(candidateTwoDir, 'artifacts/recipe.json', '{"entry":"two"}');

  const familyRun = makeRun({
    id: 'pr-complete-run',
    familyId: 'family-pr',
    familyRootTicketOrPr: 'example-org/example-browser#42009',
    ticketOrPr: 'example-org/example-browser#42009',
    project: 'example-browser-farm',
    flowType: 'pr-complete',
    prNumber: 42009,
    branch: 'feat/proj-2691-persist-perp-reopen-state',
    taskFile: path.join(familyDir, 'TASK.md'),
  });
  const candidateOne = makeRun({
    id: 'candidate-one',
    familyId: 'family-one',
    project: 'example-browser-farm',
    prNumber: 42009,
    branch: 'feat/proj-2691-persist-perp-reopen-state',
    taskFile: path.join(candidateOneDir, 'TASK.md'),
    updatedAt: '2026-04-14T00:00:00.000Z',
  });
  const candidateTwo = makeRun({
    id: 'candidate-two',
    familyId: 'family-two',
    project: 'example-browser-farm',
    prNumber: 42009,
    branch: 'feat/proj-2691-persist-perp-reopen-state',
    taskFile: path.join(candidateTwoDir, 'TASK.md'),
    updatedAt: '2026-04-15T00:00:00.000Z',
  });

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns(
    [familyRun],
    [familyRun, candidateOne, candidateTwo],
  );
  const run = snapshot.runs[0];

  assert.equal(run.recipeJson, null);
  assert.equal(run.recipeProvenance?.status, 'ambiguous');
  assert.deepEqual(run.recipeProvenance?.candidateRunIds, ['candidate-two', 'candidate-one']);
  assert.equal(run.missingData.includes('recipe-json'), true);
  assert.equal(run.missingData.includes('recipe-provenance-ambiguous'), true);
  assert.equal(snapshot.missingData.includes('family-recipe'), true);
  assert.equal(snapshot.missingData.includes('family-recipe-provenance-ambiguous'), true);
});

test('family report generation reuses cache until forceRefresh is requested', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-report-cache-'));
  const taskDir = path.join(base, 'root');
  await writeArtifact(taskDir, 'TASK.md', '# Root task');
  await writeArtifact(taskDir, 'artifacts/report.md', 'Root report');

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'report-run',
      familyId: 'family-report-cache',
      taskFile: path.join(taskDir, 'TASK.md'),
      summary: 'Report cache root',
    }),
  ]);

  let reportCalls = 0;
  const reportDeps = {
    callLLM: async () => {
      reportCalls += 1;
      return {
        text: JSON.stringify({
          summary: 'Cached report summary',
          evidenceHighlights: ['Root report'],
          recipeAssessment: 'Recipe signal summarized.',
          learnings: [],
          unresolvedGaps: [],
        }),
        usage: { provider: 'test', model: 'deterministic', durationMs: 0 },
      };
    },
  };

  const cached = await generateFamilyReport(snapshot, false, reportDeps);
  const reused = await generateFamilyReport(snapshot, false, reportDeps);

  assert.strictEqual(reused, cached);
  assert.equal(reportCalls, 1);

  const refreshed = await generateFamilyReport(snapshot, true, reportDeps);

  assert.equal(reportCalls, 2);
  assert.notStrictEqual(refreshed, cached);
  assert.equal(refreshed.status, 'generated');
});

test('snapshot honors FLOW_WORKER_REPORT_ARTIFACTS for pr-complete (comments-report.md, not report.md)', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-flow-report-'));
  const taskDir = path.join(base, 'pr-complete');
  await writeArtifact(taskDir, 'TASK.md', '# pr-complete');
  await writeArtifact(taskDir, 'artifacts/comments-report.md', '## Summary\nResolved 6 comments.');

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'pr-complete-run',
      familyId: 'family-pc',
      familyRootTicketOrPr: 'owner/repo#1',
      ticketOrPr: 'owner/repo#1',
      flowType: 'pr-complete',
      taskFile: path.join(taskDir, 'TASK.md'),
      steps: [{ name: 'complete', status: 'done' }],
    }),
  ]);

  const summary = snapshot.runs[0];
  assert.match(summary.workerReport ?? '', /Resolved 6 comments/);
  assert.equal(summary.missingData.includes('worker-report'), false);
});

test('snapshot flags worker-learnings missing for pr-complete without learnings.md', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-no-actionable-'));
  const taskDir = path.join(base, 'pr-complete');
  await writeArtifact(taskDir, 'TASK.md', '# pr-complete');
  await writeArtifact(
    taskDir,
    'artifacts/comments-report.md',
    '## Summary\nNo actionable comments',
  );
  await writeArtifact(
    taskDir,
    'artifacts/comments-triage.json',
    JSON.stringify([
      { triage: 'FALSE_POSITIVE', fixed_in_commit: null, path: 'src/a.ts' },
      { triage: 'OUT_OF_SCOPE', fixed_in_commit: null, path: 'src/b.ts' },
    ]),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'pr-complete-noop',
      familyId: 'family-noop',
      familyRootTicketOrPr: 'owner/repo#2',
      ticketOrPr: 'owner/repo#2',
      flowType: 'pr-complete',
      taskFile: path.join(taskDir, 'TASK.md'),
      steps: [{ name: 'complete', status: 'done' }],
    }),
  ]);

  assert.equal(snapshot.runs[0].missingData.includes('worker-learnings'), true);
});

test('snapshot DOES flag worker-learnings missing for pr-complete with actionable comments but no learnings.md', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-actionable-no-learn-'));
  const taskDir = path.join(base, 'pr-complete');
  await writeArtifact(taskDir, 'TASK.md', '# pr-complete');
  await writeArtifact(taskDir, 'artifacts/comments-report.md', '## Summary\nFixed 1 comment');
  await writeArtifact(
    taskDir,
    'artifacts/comments-triage.json',
    JSON.stringify([{ triage: 'REAL', fixed_in_commit: 'abc1234', path: 'src/a.ts' }]),
  );
  // Note: NO learnings.md written — worker should have but didn't.

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'pr-complete-gap',
      familyId: 'family-gap',
      familyRootTicketOrPr: 'owner/repo#3',
      ticketOrPr: 'owner/repo#3',
      flowType: 'pr-complete',
      taskFile: path.join(taskDir, 'TASK.md'),
      steps: [{ name: 'complete', status: 'done' }],
    }),
  ]);

  assert.equal(snapshot.runs[0].missingData.includes('worker-learnings'), true);
});
