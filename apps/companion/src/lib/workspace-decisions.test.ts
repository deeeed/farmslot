import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import {
  HELD_EVIDENCE_MANIFEST,
  HELD_PACKAGE_HASH,
  heldGateRun,
  newerSlimRow,
} from '../features/run-detail/held-detail.fixtures';
import { heldDetailWithNewerRow } from '../features/run-detail/run-detail-reads';

import { DECISION_EVIDENCE_RECIPE_RUN_PARAM } from './artifact-url';
import {
  selectArtifactWorkspaceDecision,
  selectPrimaryWorkspaceDecision,
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  selectReviewWorkspaceDecision,
  supersedingResultDecisionId,
  workspaceDecisionKind,
} from './workspace-decisions';

test('choosing another attempt drops the retained decision inventory', () => {
  const gate = decision({
    id: 'frozen-gate',
    payload: {
      kind: 'ready',
      prNumber: 1,
      repo: 'owner/repo',
      diffStat: { files: 1, additions: 1, deletions: 0 },
      workerReport: 'Ready.',
      branch: 'feature/test',
      artifactManifest: [],
      publicationStatus: 'published_draft',
    },
  });
  const run = { decisions: [gate] };
  assert.equal(selectArtifactWorkspaceDecision(run, 'decision-evidence', gate.id), gate);
  assert.equal(selectArtifactWorkspaceDecision(run, 'decision-evidence', ''), gate);
  assert.equal(selectArtifactWorkspaceDecision(run, 'another-attempt', gate.id), undefined);
  assert.equal(selectArtifactWorkspaceDecision(run, 'current-artifacts', gate.id), undefined);
});

function decision(overrides: Partial<RunDecision>): RunDecision {
  return {
    id: 'decision-1',
    type: 'monitor_ready_gate',
    title: 'Decision',
    description: 'Decision body',
    actions: [],
    createdAt: '2026-05-21T00:00:00.000Z',
    ...overrides,
  } as RunDecision;
}

test('workspace decision selectors expose review and retro independently', () => {
  const ready = decision({
    id: 'ready-old',
    createdAt: '2026-05-21T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: 1,
      repo: 'owner/repo',
      diffStat: { files: 1, additions: 2, deletions: 0 },
      workerReport: 'ready',
      branch: 'feature/x',
      artifactManifest: [],
      publicationStatus: 'published_draft',
    },
  });
  const review = decision({
    id: 'review-new',
    createdAt: '2026-05-21T00:02:00.000Z',
    payload: {
      kind: 'review',
      prNumber: 1,
      repo: 'owner/repo',
      recommendation: 'APPROVE',
      reviewMd: 'review',
      lineComments: [],
      artifactManifest: [],
      reviewInputArtifactPaths: [],
    },
  });
  const retro = decision({
    id: 'retro',
    type: 'retrospective',
    createdAt: '2026-05-21T00:03:00.000Z',
    payload: {
      kind: 'retrospective',
      outcome: 'success',
      whatThisIs: 'retro',
      reviewSummary: 'retro',
      actionEffects: [],
    },
  });

  const source = { decisions: [ready, retro, review] };
  assert.equal(selectReadyWorkspaceDecision(source)?.id, 'ready-old');
  assert.equal(selectReviewGateWorkspaceDecision(source)?.id, 'review-new');
  assert.equal(selectReviewWorkspaceDecision(source)?.id, 'review-new');
  assert.equal(selectRetrospectiveWorkspaceDecision(source)?.id, 'retro');
  assert.equal(selectPrimaryWorkspaceDecision(source)?.id, 'review-new');
});

test('workspace decision selectors prefer pending before newer resolved matches', () => {
  const pending = decision({
    id: 'pending-ready',
    createdAt: '2026-05-21T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: 1,
      repo: 'owner/repo',
      diffStat: { files: 1, additions: 1, deletions: 0 },
      workerReport: 'pending',
      branch: 'feature/x',
      artifactManifest: [],
      publicationStatus: 'published_draft',
    },
  });
  const resolved = decision({
    id: 'resolved-ready',
    createdAt: '2026-05-21T00:10:00.000Z',
    resolvedAt: '2026-05-21T00:11:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: 1,
      repo: 'owner/repo',
      diffStat: { files: 1, additions: 2, deletions: 0 },
      workerReport: 'resolved',
      branch: 'feature/x',
      artifactManifest: [],
      publicationStatus: 'published_draft',
    },
  });

  const source = { decisions: [resolved, pending] };
  assert.equal(selectReadyWorkspaceDecision(source)?.id, pending.id);
  assert.equal(selectReviewWorkspaceDecision(source)?.id, pending.id);
});

test('workspaceDecisionKind falls back to decision type', () => {
  assert.equal(workspaceDecisionKind(decision({ type: 'retrospective' })), 'retrospective');
});

test('a pending result decision is the primary workspace decision', () => {
  const output = decision({
    id: 'output-1',
    type: 'engine_output_review',
    createdAt: '2026-05-21T02:00:00.000Z',
    payload: { kind: 'output-review', manifestDigest: 'sha256:m', reportPath: 'artifacts/r.md' },
  });
  const result = decision({
    id: 'result-1',
    type: 'engine_result_decision',
    createdAt: '2026-05-21T01:00:00.000Z',
    payload: {
      kind: 'result-decision',
      stoppedAt: 'review',
      reason: 'The review left findings and no further fix can run.',
      delivered: { headSha: 'abc123' },
      findingsDigest: 'sha256:f',
      outputReviewDecisionId: 'output-1',
      actions: [{ id: 'close-result', available: true, requiresReason: false }],
    },
  });
  assert.equal(selectPrimaryWorkspaceDecision({ decisions: [output, result] })?.id, 'result-1');
  assert.equal(
    selectPrimaryWorkspaceDecision({
      decisions: [output, { ...result, resolvedAt: '2026-05-21T03:00:00.000Z' }],
    })?.id,
    'output-1',
  );
});

test('a re-presented result decision replaces the superseded one on screen', () => {
  const result = decision({
    id: 'result-1',
    type: 'engine_result_decision',
    payload: {
      kind: 'result-decision',
      stoppedAt: 'complete',
      reason: 'Completion refused.',
      delivered: { reportPath: 'artifacts/r.md', manifestDigest: 'sha256:m' },
      findingsDigest: 'sha256:f',
      actions: [{ id: 'close-result', available: true, requiresReason: false }],
    },
  });
  const superseded = { ...result, resolvedAt: '2026-05-21T03:00:00.000Z' };
  const next = { ...result, id: 'result-2' };
  assert.equal(
    supersedingResultDecisionId(superseded, { decisions: [superseded, next] }),
    'result-2',
  );
  assert.equal(supersedingResultDecisionId(next, { decisions: [superseded, next] }), undefined);
  assert.equal(supersedingResultDecisionId(superseded, { decisions: [superseded] }), undefined);
  assert.equal(supersedingResultDecisionId(superseded, null), undefined);
  const output = decision({
    id: 'output-1',
    payload: { kind: 'output-review', manifestDigest: 'sha256:m', reportPath: 'artifacts/r.md' },
  });
  assert.equal(supersedingResultDecisionId(output, { decisions: [output, next] }), undefined);
});

// The artifact viewer freezes its gate from the run Run Detail hands it. Under a newer slim row
// that gate is still the held one, with the package hash and manifest the viewer reads.
test('the artifact viewer gate under a newer slim row keeps the held package', () => {
  const held = heldGateRun();
  const row = newerSlimRow(held);
  for (const explicitId of ['', 'gate-1']) {
    const gate = selectArtifactWorkspaceDecision(
      heldDetailWithNewerRow(held, row),
      DECISION_EVIDENCE_RECIPE_RUN_PARAM,
      explicitId,
    );
    const payload = gate?.payload;
    assert.equal(payload?.kind, 'ready', explicitId);
    if (payload?.kind !== 'ready') continue;
    assert.equal(payload.prPackage?.packageHash, HELD_PACKAGE_HASH, explicitId);
    assert.deepEqual(payload.prPackage?.evidenceManifest, HELD_EVIDENCE_MANIFEST, explicitId);
  }
  // The row's own gate is display data: its payload has no package to freeze.
  const listed = selectReadyWorkspaceDecision(row)?.payload;
  assert.equal(listed && 'prPackage' in listed, false);
});
