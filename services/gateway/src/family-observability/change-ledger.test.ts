import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildFamilyObservabilitySnapshotFromRuns } from './snapshot.js';
import { makeRun, writeArtifact } from './test-fixtures.js';

test('snapshot builds family change ledger from durable diff and review-signal artifacts', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-ledger-'));
  const rootDir = path.join(base, 'root');
  const followDir = path.join(base, 'follow');

  await writeArtifact(rootDir, 'TASK.md', '# Root');
  await writeArtifact(rootDir, 'artifacts/diff.txt', 'diff --git a/src/a.ts b/src/a.ts');
  await writeArtifact(
    rootDir,
    'artifacts/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 2,
      additions: 12,
      deletions: 3,
      kind: 'contribution',
      artifactPath: 'artifacts/diff.txt',
      baseRef: 'main',
      headRef: 'abc123',
      capturedAt: '2026-04-15T00:10:00.000Z',
    }),
  );
  await writeArtifact(followDir, 'TASK.md', '# Follow');
  await writeArtifact(
    followDir,
    'inputs/commit.json',
    JSON.stringify({
      repository: 'owner/repo',
      prNumber: 123,
      baseRef: 'main',
      headRef: 'fix/proj-1',
      capturedAt: '2026-04-15T00:20:00.000Z',
      source: 'github-pr',
    }),
  );
  await writeArtifact(followDir, 'inputs/diff.txt', 'diff --git a/src/a.ts b/src/a.ts');
  await writeArtifact(
    followDir,
    'inputs/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 2,
      additions: 12,
      deletions: 3,
      kind: 'review-input',
      capturedAt: '2026-04-15T00:20:00.000Z',
    }),
  );
  await writeArtifact(
    followDir,
    'artifacts/comments-triage.json',
    JSON.stringify([
      {
        triage: 'REAL',
        fixed_in_commit: 'def456',
        path: 'src/a.ts',
        source_kind: 'bugbot',
        author_login: 'cursor[bot]',
        author_type: 'Bot',
        comment_id: 1,
      },
      {
        triage: 'REAL',
        fixed_in_commit: 'fed321',
        path: 'src/b.ts',
        source_kind: 'human',
        author_login: 'alice',
        author_type: 'User',
        reviewer_login: 'alice',
        review_state: 'CHANGES_REQUESTED',
        comment_id: 2,
        review_id: 20,
      },
      {
        triage: 'FALSE_POSITIVE',
        fixed_in_commit: null,
        path: 'src/c.ts',
        source_kind: 'unknown',
        comment_id: 3,
      },
    ]),
  );

  const root = makeRun({
    id: 'root-run',
    familyId: 'family-ledger',
    familyRootTicketOrPr: 'PROJ-1',
    ticketOrPr: 'PROJ-1',
    taskFile: path.join(rootDir, 'TASK.md'),
    branch: 'fix/proj-1',
    prNumber: 123,
    completedAt: '2026-04-15T00:11:00.000Z',
  });
  const follow = makeRun({
    id: 'follow-run',
    familyId: 'family-ledger',
    familyRootTicketOrPr: 'PROJ-1',
    parentRunId: 'root-run',
    flowType: 'pr-complete',
    ticketOrPr: 'owner/repo#123',
    taskFile: path.join(followDir, 'TASK.md'),
    branch: 'fix/proj-1',
    prNumber: 123,
    updatedAt: '2026-04-15T00:30:00.000Z',
    completedAt: '2026-04-15T00:31:00.000Z',
  });

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([root, follow]);

  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.familyChangeLedger.entries.length, 2);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithDiff, 2);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithContributionDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithReviewInputDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.totalContributionAdditions, 12);
  assert.equal(snapshot.familyChangeLedger.summary.bugbotFindingsAddressed, 1);
  assert.equal(snapshot.familyChangeLedger.summary.humanReviewersRequestingChanges, 1);
  assert.equal(snapshot.familyChangeLedger.summary.humanCommentsAddressed, 1);
  assert.equal(snapshot.familyChangeLedger.summary.artifactFootprint.count > 0, true);
  assert.equal(
    snapshot.familyChangeLedger.summary.artifactFootprint.bySource.some(
      (bucket) => bucket.key === 'task-input',
    ),
    true,
  );
  const followEntry = snapshot.familyChangeLedger.entries.find(
    (entry) => entry.runId === 'follow-run',
  );
  assert(followEntry);
  assert.equal(followEntry.familyId, 'family-ledger');
  assert.equal(followEntry.parentRunId, 'root-run');
  assert.equal(followEntry.familyRootTicketOrPr, 'PROJ-1');
  assert.equal(followEntry.lane, 'production');
  assert.equal(followEntry.flowType, 'pr-complete');
  assert.equal(followEntry.inputDiff?.source, 'artifact');
  assert.equal(
    followEntry.artifactFootprint.byPurpose.some((bucket) => bucket.key === 'input-diff'),
    true,
  );
  assert.equal(
    followEntry.taskInputArtifacts.some(
      (artifact) => artifact.source === 'task-input' && artifact.path === 'inputs/diff.txt',
    ),
    true,
  );
  assert.equal(followEntry.reviewSignals?.unknownSource, 1);
});

test('snapshot treats review-pr input diffs as reviewed inputs without missing contribution noise', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-review-input-'));
  const reviewDir = path.join(base, 'review');
  await writeArtifact(reviewDir, 'TASK.md', '# Review');
  await writeArtifact(
    reviewDir,
    'inputs/commit.json',
    JSON.stringify({
      repository: 'owner/repo',
      prNumber: 123,
      baseRef: 'main',
      headRef: 'feature',
      capturedAt: '2026-04-15T00:20:00.000Z',
      source: 'github-pr',
    }),
  );
  await writeArtifact(reviewDir, 'inputs/diff.txt', 'diff --git a/src/a.ts b/src/a.ts');
  await writeArtifact(
    reviewDir,
    'inputs/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 1,
      additions: 4,
      deletions: 1,
      kind: 'review-input',
      capturedAt: '2026-04-15T00:20:00.000Z',
    }),
  );

  const reviewRun = makeRun({
    id: 'review-run',
    familyId: 'family-review',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#123',
    taskFile: path.join(reviewDir, 'TASK.md'),
    prNumber: 123,
  });

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([reviewRun]);
  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithContributionDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithReviewInputDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithEmptyReviewInputDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsMissingDiff, 0);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(entry.changeKind, 'review-input');
  assert.equal(entry.missingData.includes('missing-diff-stat-artifact'), false);
  assert.equal(entry.missingData.includes('diff-artifact'), false);
});

test('snapshot derives PR number from review-pr ticket refs when not persisted', async () => {
  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'review-run',
      familyId: 'family-review',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#29655',
      prNumber: undefined,
    }),
  ]);

  assert.equal(snapshot.runs[0].prNumber, 29655);
});

test('snapshot keeps unavailable review input separate from missing contribution counters', async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), 'family-observability-review-input-unavailable-'),
  );
  const reviewDir = path.join(base, 'review');
  await writeArtifact(reviewDir, 'TASK.md', '# Review');
  await writeArtifact(
    reviewDir,
    'inputs/commit.json',
    JSON.stringify({
      repository: 'owner/repo',
      prNumber: 123,
      capturedAt: '2026-04-15T00:20:00.000Z',
      source: 'unavailable',
      missingReason: 'github-pr-input-unavailable',
    }),
  );
  await writeArtifact(
    reviewDir,
    'inputs/diff-stat.json',
    JSON.stringify({
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'review-input',
      repository: 'owner/repo',
      prNumber: 123,
      missingReason: 'github-pr-input-unavailable',
      capturedAt: '2026-04-15T00:20:00.000Z',
    }),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'review-run-unavailable',
      familyId: 'family-review-unavailable',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#123',
      taskFile: path.join(reviewDir, 'TASK.md'),
      prNumber: 123,
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithContributionDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithReviewInputDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithEmptyReviewInputDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithUnavailableReviewInputDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsMissingDiff, 0);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(entry.inputDiff?.kind, 'review-input');
  assert.equal(entry.inputDiff?.missingReason, 'github-pr-input-unavailable');
  assert.equal(entry.missingData.includes('github-pr-input-unavailable'), true);
  assert.equal(entry.missingData.includes('diff-artifact'), false);
});

test('snapshot does not count review-pr runs with no input artifact as missing contribution diffs', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-review-no-input-'));
  const reviewDir = path.join(base, 'review');
  await writeArtifact(reviewDir, 'TASK.md', '# Review');

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'review-run-no-input',
      familyId: 'family-review-no-input',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#123',
      taskFile: path.join(reviewDir, 'TASK.md'),
      prNumber: 123,
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsMissingDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithContributionDiff, 0);
  assert.equal(snapshot.familyChangeLedger.entries[0].missingData.includes('diff-artifact'), false);
});

test('snapshot does not double-count a slot-tree review-input artifact written under artifacts/diff-stat.json on review-pr runs', async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), 'family-observability-review-input-slot-tree-'),
  );
  const reviewDir = path.join(base, 'review');
  await writeArtifact(reviewDir, 'TASK.md', '# Review');
  // COMPLETE writes artifacts/diff-stat.json from the slot tree on every flow.
  // For review-pr runs the kind is 'review-input' — it must not register as a
  // contribution diff or the family ledger would mark review-only runs as
  // follow-up and double the totalContribution* totals against inputs/.
  await writeArtifact(
    reviewDir,
    'artifacts/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 1,
      additions: 4,
      deletions: 1,
      kind: 'review-input',
      filter: 'source-code',
      artifactPath: 'artifacts/diff.txt',
      capturedAt: '2026-04-15T00:20:00.000Z',
    }),
  );
  await writeArtifact(
    reviewDir,
    'inputs/commit.json',
    JSON.stringify({
      repository: 'owner/repo',
      prNumber: 123,
      baseRef: 'main',
      headRef: 'feature',
      capturedAt: '2026-04-15T00:20:00.000Z',
      source: 'github-pr',
    }),
  );
  await writeArtifact(reviewDir, 'inputs/diff.txt', 'diff --git a/src/a.ts b/src/a.ts');
  await writeArtifact(
    reviewDir,
    'inputs/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 1,
      additions: 4,
      deletions: 1,
      kind: 'review-input',
      capturedAt: '2026-04-15T00:20:00.000Z',
    }),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'review-run-slot-tree',
      familyId: 'family-review-slot-tree',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#123',
      taskFile: path.join(reviewDir, 'TASK.md'),
      prNumber: 123,
      parentRunId: 'root-run',
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(entry.changeKind, 'review-input');
  assert.equal(entry.contributionDiff.available, false);
  assert.equal(entry.contributionDiff.missingReason, 'missing-diff-stat-artifact');
  assert.equal(entry.inputDiff?.available, true);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithContributionDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.totalContributionFiles, 0);
  assert.equal(snapshot.familyChangeLedger.summary.totalContributionAdditions, 0);
  assert.equal(snapshot.familyChangeLedger.summary.totalContributionDeletions, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithReviewInputDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsMissingDiff, 0);
  assert.equal(entry.missingData.includes('diff-artifact'), false);
});

test('snapshot still surfaces malformed contribution diff artifacts on review-pr runs', async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), 'family-observability-review-malformed-contribution-'),
  );
  const reviewDir = path.join(base, 'review');
  await writeArtifact(reviewDir, 'TASK.md', '# Review');
  await writeArtifact(reviewDir, 'artifacts/diff-stat.json', '{not json');

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'review-run-malformed-contribution',
      familyId: 'family-review-malformed-contribution',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#123',
      taskFile: path.join(reviewDir, 'TASK.md'),
      prNumber: 123,
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  const run = snapshot.runs[0];
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(run.missingData.includes('malformed-diff-stat-artifact'), true);
  assert.equal(entry.missingData.includes('malformed-diff-stat-artifact'), true);
  assert.equal(snapshot.familyChangeLedger.summary.runsMissingDiff, 0);
});

test('snapshot surfaces malformed review input diff stats in unavailable counters', async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), 'family-observability-review-input-malformed-'),
  );
  const reviewDir = path.join(base, 'review');
  await writeArtifact(reviewDir, 'TASK.md', '# Review');
  await writeArtifact(
    reviewDir,
    'inputs/commit.json',
    JSON.stringify({
      repository: 'owner/repo',
      prNumber: 123,
      capturedAt: '2026-04-15T00:20:00.000Z',
      source: 'github-pr',
    }),
  );
  await writeArtifact(reviewDir, 'inputs/diff-stat.json', '{not json');

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'review-run-malformed',
      familyId: 'family-review-malformed',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#123',
      taskFile: path.join(reviewDir, 'TASK.md'),
      prNumber: 123,
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithReviewInputDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithEmptyReviewInputDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithUnavailableReviewInputDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsMissingDiff, 0);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(entry.inputDiff?.missingReason, 'malformed-input-diff-stat');
  assert.equal(entry.missingData.includes('malformed-input-diff-stat'), true);
});

test('snapshot counts binary-only reviewed input as explicit empty review input', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-review-input-empty-'));
  const reviewDir = path.join(base, 'review');
  await writeArtifact(reviewDir, 'TASK.md', '# Review');
  await writeArtifact(
    reviewDir,
    'inputs/commit.json',
    JSON.stringify({
      repository: 'owner/repo',
      prNumber: 123,
      capturedAt: '2026-04-15T00:20:00.000Z',
      source: 'github-pr',
    }),
  );
  await writeArtifact(
    reviewDir,
    'inputs/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'review-input',
      filter: 'source-code',
      repository: 'owner/repo',
      prNumber: 123,
      missingReason: 'no-source-diff',
      configFallbackReason: 'project-config-unavailable',
      capturedAt: '2026-04-15T00:20:00.000Z',
    }),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'review-run-empty',
      familyId: 'family-review-empty',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#123',
      taskFile: path.join(reviewDir, 'TASK.md'),
      prNumber: 123,
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithReviewInputDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithEmptyReviewInputDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithUnavailableReviewInputDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsMissingDiff, 0);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(entry.changeKind, 'review-input');
  assert.equal(entry.inputDiff?.missingReason, 'no-source-diff');
  assert.equal(entry.missingData.includes('project-config-fallback'), true);
  assert.equal(entry.missingData.includes('input-diff'), false);
});

test('snapshot prefers iteration diff for follow-up pr-complete over GitHub input', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-pr-complete-iteration-'));
  const taskDir = path.join(base, 'followup');
  await writeArtifact(taskDir, 'TASK.md', '# PR complete');
  await writeArtifact(
    taskDir,
    'artifacts/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 682,
      additions: 12736,
      deletions: 14645,
      kind: 'contribution',
      filter: 'source-code',
      artifactPath: 'artifacts/diff.txt',
      baseRef: 'origin/main',
      capturedAt: '2026-05-08T15:03:05.900Z',
    }),
  );
  await writeArtifact(
    taskDir,
    'artifacts/iteration-diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 2,
      additions: 8,
      deletions: 1,
      kind: 'iteration',
      filter: 'source-code',
      artifactPath: 'artifacts/iteration-diff.txt',
      baseRef: 'dispatchHead:abc123',
      capturedAt: '2026-05-08T15:03:05.900Z',
    }),
  );
  await writeArtifact(taskDir, 'inputs/diff.txt', 'diff --git a/app/a.ts b/app/a.ts');
  await writeArtifact(
    taskDir,
    'inputs/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 3,
      additions: 236,
      deletions: 66,
      kind: 'review-input',
      filter: 'source-code',
      artifactPath: 'inputs/diff.txt',
      repository: 'example-org/example-mobile',
      prNumber: 29800,
      baseRef: 'main',
      capturedAt: '2026-05-08T15:02:50.064Z',
    }),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'pr-complete-follow-up',
      familyId: 'family-pr-complete-iteration',
      parentRunId: 'root-run',
      flowType: 'pr-complete',
      ticketOrPr: 'example-org/example-mobile#29800',
      taskFile: path.join(taskDir, 'TASK.md'),
      prNumber: 29800,
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.diffStat.files, 2);
  assert.equal(snapshot.diffStat.additions, 8);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(entry.changeKind, 'follow-up');
  assert.equal(entry.iterationDiff?.available, true);
  assert.equal(snapshot.familyChangeLedger.summary.totalContributionAdditions, 8);
});

test('snapshot prefers PR input diff over stale pr-complete contribution diff', async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), 'family-observability-pr-complete-input-wins-'),
  );
  const taskDir = path.join(base, 'followup');
  await writeArtifact(taskDir, 'TASK.md', '# PR complete');
  await writeArtifact(taskDir, 'artifacts/diff.txt', 'diff --git a/unrelated.ts b/unrelated.ts');
  await writeArtifact(
    taskDir,
    'artifacts/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 682,
      additions: 12736,
      deletions: 14645,
      kind: 'contribution',
      filter: 'source-code',
      artifactPath: 'artifacts/diff.txt',
      baseRef: 'main',
      capturedAt: '2026-05-08T15:03:05.900Z',
    }),
  );
  await writeArtifact(taskDir, 'inputs/diff.txt', 'diff --git a/app/a.ts b/app/a.ts');
  await writeArtifact(
    taskDir,
    'inputs/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 3,
      additions: 236,
      deletions: 66,
      kind: 'review-input',
      filter: 'source-code',
      artifactPath: 'inputs/diff.txt',
      repository: 'example-org/example-mobile',
      prNumber: 29800,
      baseRef: 'main',
      capturedAt: '2026-05-08T15:02:50.064Z',
    }),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'pr-complete-follow-up',
      familyId: 'family-pr-complete-input-wins',
      flowType: 'pr-complete',
      ticketOrPr: 'example-org/example-mobile#29800',
      taskFile: path.join(taskDir, 'TASK.md'),
      prNumber: 29800,
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.diffStat.available, true);
  assert.equal(snapshot.diffStat.files, 3);
  assert.equal(snapshot.diffStat.additions, 236);
  assert.equal(snapshot.diffStat.deletions, 66);
  assert.equal(snapshot.runs[0].diffStat.files, 3);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(entry.changeKind, 'review-input');
  assert.equal(entry.inputDiff?.artifactPath, 'inputs/diff.txt');
  assert.equal(entry.contributionDiff.files, 682);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithContributionDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithReviewInputDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.totalContributionFiles, 0);
});

test('snapshot does not require reviewed-input artifacts for pr-complete runs with contribution diffs', async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), 'family-observability-pr-complete-contribution-'),
  );
  const taskDir = path.join(base, 'followup');
  await writeArtifact(taskDir, 'TASK.md', '# PR complete');
  await writeArtifact(taskDir, 'artifacts/diff.txt', 'diff --git a/src/a.ts b/src/a.ts');
  await writeArtifact(
    taskDir,
    'artifacts/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: true,
      files: 1,
      additions: 3,
      deletions: 1,
      kind: 'contribution',
      filter: 'source-code',
      artifactPath: 'artifacts/diff.txt',
      capturedAt: '2026-05-03T00:00:00.000Z',
    }),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'pr-complete-contribution',
      familyId: 'family-pr-complete-contribution',
      flowType: 'pr-complete',
      ticketOrPr: 'owner/repo#123',
      taskFile: path.join(taskDir, 'TASK.md'),
      prNumber: 123,
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(snapshot.familyChangeLedger.summary.runsWithContributionDiff, 1);
  assert.equal(entry.changeKind, 'contribution');
  assert.equal(entry.missingData.includes('input-diff'), false);
  assert.equal(entry.missingData.includes('commit-metadata'), false);
});

test('snapshot does not require reviewed-input artifacts for pr-complete runs without contribution diffs', async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), 'family-observability-pr-complete-no-contribution-'),
  );
  const taskDir = path.join(base, 'followup');
  await writeArtifact(taskDir, 'TASK.md', '# PR complete comments only');
  await writeArtifact(
    taskDir,
    'artifacts/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      filter: 'source-code',
      missingReason: 'no-source-diff',
      capturedAt: '2026-05-03T00:00:00.000Z',
    }),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'pr-complete-no-contribution',
      familyId: 'family-pr-complete-no-contribution',
      flowType: 'pr-complete',
      ticketOrPr: 'owner/repo#123',
      taskFile: path.join(taskDir, 'TASK.md'),
      prNumber: 123,
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(entry.missingData.includes('input-diff'), false);
  assert.equal(entry.missingData.includes('commit-metadata'), false);
});

test('snapshot does not count filtered-empty contribution diff as a captured contribution', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-no-source-diff-'));
  const taskDir = path.join(base, 'root');
  await writeArtifact(taskDir, 'TASK.md', '# Branch-only run');
  await writeArtifact(taskDir, 'artifacts/diff.txt', '');
  await writeArtifact(
    taskDir,
    'artifacts/diff-stat.json',
    JSON.stringify({
      source: 'artifact',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
      filter: 'source-code',
      artifactPath: 'artifacts/diff.txt',
      missingReason: 'no-source-diff',
      capturedAt: '2026-05-03T00:00:00.000Z',
    }),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'branch-only-run',
      familyId: 'family-no-source',
      taskFile: path.join(taskDir, 'TASK.md'),
      branch: 'fix/branch-only',
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithContributionDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.runsMissingDiff, 1);
  const entry = snapshot.familyChangeLedger.entries[0];
  assert.equal(entry.changeKind, 'none');
  assert.equal(entry.contributionDiff.available, false);
  assert.equal(entry.missingData.includes('no-source-diff'), false);
});

test('snapshot includes partial numstat totals for oversized contribution diffs', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-diff-too-large-'));
  const taskDir = path.join(base, 'root');
  await writeArtifact(taskDir, 'TASK.md', '# Large diff');
  await writeArtifact(
    taskDir,
    'artifacts/diff-stat.json',
    JSON.stringify({
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      partialStat: { files: 5, additions: 120, deletions: 9 },
      kind: 'contribution',
      filter: 'source-code',
      missingReason: 'diff-artifact-too-large',
      capturedAt: '2026-05-03T00:00:00.000Z',
    }),
  );

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'large-diff-run',
      familyId: 'family-large-diff',
      taskFile: path.join(taskDir, 'TASK.md'),
    }),
  ]);

  assert(snapshot.familyChangeLedger);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsWithContributionDiff, 1);
  assert.equal(snapshot.familyChangeLedger.summary.runsMissingDiff, 0);
  assert.equal(snapshot.familyChangeLedger.summary.totalContributionFiles, 5);
  assert.equal(snapshot.familyChangeLedger.summary.totalContributionAdditions, 120);
  assert.equal(snapshot.familyChangeLedger.summary.totalContributionDeletions, 9);
});

test('snapshot flags artifact scans that hit the per-run file cap', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-artifact-cap-'));
  const taskDir = path.join(base, 'root');
  await writeArtifact(taskDir, 'TASK.md', '# Many artifacts');
  const bulkDir = path.join(taskDir, 'artifacts/bulk');
  await mkdir(bulkDir, { recursive: true });
  const artifactIndexes = Array.from({ length: 2001 }, (_, index) => index);
  for (let offset = 0; offset < artifactIndexes.length; offset += 100) {
    await Promise.all(
      artifactIndexes
        .slice(offset, offset + 100)
        .map((index) => writeFile(path.join(bulkDir, `evidence-${index}.txt`), 'x', 'utf-8')),
    );
  }

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'artifact-cap-run',
      familyId: 'family-artifact-cap',
      taskFile: path.join(taskDir, 'TASK.md'),
    }),
  ]);

  assert.equal(snapshot.runs[0].missingData.includes('artifacts-truncated'), true);
});
