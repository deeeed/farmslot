import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import {
  selectPrimaryWorkspaceDecision,
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  selectReviewWorkspaceDecision,
  workspaceDecisionKind,
} from './workspace-decisions';

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
      selfReviewSummary: 'retro',
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
