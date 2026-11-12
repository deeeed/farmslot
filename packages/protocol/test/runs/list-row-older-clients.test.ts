import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import { runListRow, trimRunForList } from '../../src/runs/list-trim.js';

import {
  diffArtifactCandidate,
  diffStatFromRun,
  evidenceSummaryFromRun,
  extractRunArtifactManifest,
  summarizeRunEvidence,
} from './default-branch-readers.fixtures.js';

/** A finished run with evidence of every kind a list surface shows, held in step outputs. */
function evidenceRun(): Run {
  return {
    id: 'older-client',
    familyId: 'family-older',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'demo',
    ticketOrPr: 'TEAM-5',
    slotId: null,
    branch: 'fix/login',
    taskFile: null,
    steps: [
      {
        name: 'monitor',
        status: 'done',
        outputs: {
          transcript: 't'.repeat(4000),
          patch: 'artifacts/changes.patch',
          diffStat: { files: 3, additions: 20, deletions: 5 },
          artifacts: [
            { path: 'evidence/before-login.png', purpose: 'before screenshot', sizeBytes: 400 },
            { path: 'evidence/after-login.png', purpose: 'after screenshot', sizeBytes: 500 },
            { path: 'evidence/walkthrough.mp4', purpose: 'video', sizeBytes: 9000 },
            { path: 'reports/recipe-report.md', purpose: 'report', sizeBytes: 100 },
            { path: 'reviews/final-review.md', purpose: 'review', sizeBytes: 200 },
            { path: 'artifacts/check.txt', purpose: 'validation', sizeBytes: 50 },
          ],
        },
      },
    ],
    decisions: [
      {
        id: 'gate',
        type: 'engine_human_gate',
        title: 'Publish',
        description: 'Publish the fix.',
        createdAt: '2026-11-01T00:10:00.000Z',
        resolvedAt: '2026-11-01T00:12:00.000Z',
        actions: [],
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          branch: 'fix/login',
          workerReport: 'Fixed the login crash.',
          diffStat: { files: 3, additions: 20, deletions: 5 },
          // A small gate manifest, under the list's per-value limit: both rows carry it.
          artifactManifest: [
            { path: 'artifacts/summary.md', purpose: 'summary' },
            { path: 'artifacts/trace.json', purpose: 'trace' },
          ],
        },
      },
    ],
    metrics: { nudgeCount: 0, model: 'opus', runner: 'claude' },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:12:00.000Z',
  };
}

/** What a client holds after reading a row off the wire: it parses the JSON as a run. */
function received(row: object): Run {
  return JSON.parse(JSON.stringify(row));
}

// Clients update separately from the gateway. A build from the default branch computes its
// list values from the row itself, with the readers copied in the fixture file. On the row
// this branch serves, they give what they gave on the row the default branch serves.
test('default-branch readers show the same chips, Diff file and diff stat from the served row', () => {
  const run = evidenceRun();
  const before = received(trimRunForList(run));
  const served = received(runListRow(run));

  // Command Center run list: the video and compare chips.
  const chips = (row: Run) => {
    const { videoCount, visualPairCount } = summarizeRunEvidence(row);
    return { videoCount, visualPairCount };
  };
  assert.deepEqual(chips(before), { videoCount: 1, visualPairCount: 1 });
  assert.deepEqual(chips(served), chips(before));

  // Companion run cards: the file the Diff action opens.
  const diffPath = (row: Run) => diffArtifactCandidate(extractRunArtifactManifest(row))?.path;
  assert.equal(diffPath(before), 'artifacts/changes.patch');
  assert.equal(diffPath(served), diffPath(before));

  // Eval catalog preview: the diff stat.
  assert.deepEqual(diffStatFromRun(before), { files: 3, additions: 20, deletions: 5 });
  assert.deepEqual(diffStatFromRun(served), diffStatFromRun(before));
});

// The served row keeps a step's videos, before/after visuals and diff files, not every
// artifact entry (stored runs average 92 of them). So the counts an older build derives are
// lower than before until it updates; a current build reads the gateway's summary.
test('default-branch readers count fewer artifacts from the served row, never more', () => {
  const run = evidenceRun();
  const before = received(trimRunForList(run));
  const served = received(runListRow(run));

  // Companion "Evidence N".
  assert.equal(extractRunArtifactManifest(before).length, 9);
  assert.equal(extractRunArtifactManifest(served).length, 6);

  // Eval catalog preview counts.
  assert.deepEqual(evidenceSummaryFromRun(before), {
    artifactCount: 6,
    artifactBytes: 10250,
    visualEvidenceCount: 3,
    validationEvidenceCount: 2,
    reviewEvidenceCount: 1,
  });
  assert.deepEqual(evidenceSummaryFromRun(served), {
    artifactCount: 4,
    artifactBytes: 9900,
    visualEvidenceCount: 3,
    validationEvidenceCount: 0,
    reviewEvidenceCount: 0,
  });

  // A current build shows the default branch's catalog numbers from the gateway's summary.
  assert.deepEqual(runListRow(run).evidenceSummary?.stepArtifacts, evidenceSummaryFromRun(before));
  assert.deepEqual(runListRow(run).evidenceSummary?.diffStat, diffStatFromRun(before));
  assert.equal(runListRow(run).evidenceSummary?.diffArtifactPath, 'artifacts/changes.patch');
});
