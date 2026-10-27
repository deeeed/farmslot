import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_ATTESTATION_ACTION,
  type GitBranchDiffFile,
  type ReadyGatePayload,
  type RunDecision,
} from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { litText } from '../../testing/lit-text.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

import {
  renderReadyDiffTab,
  renderReadyTabBar,
  renderReadyTopBar,
} from './ready-workspace-shell-renderers.js';

function gateFixture(): ReadyGatePayload {
  return {
    kind: 'ready',
    branch: 'branch',
    prNumber: null,
    repo: null,
    workerReport: 'Completed work.',
    diffStat: { files: 0, additions: 0, deletions: 0 },
    reviews: [],
    gateReadiness: {
      state: 'not-ready',
      identity: { runId: 'run', generation: 1 },
      reasons: [
        {
          code: 'evidence-policy-unsatisfied',
          prerequisite: 'evidence',
          evidencePolicy: 'execution-verdict',
          message: 'Evidence policy needs attestation.',
        },
      ],
    },
    prPackage: {
      id: 'package',
      gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'Operator review' },
      publicationTarget: 'draft',
      publicationStatus: 'not_published',
      packageHash: 'a'.repeat(64),
      artifactPath: 'artifacts/pr-package.json',
      branch: 'branch',
      headSha: 'b'.repeat(40),
      diffStat: { files: 0, additions: 0, deletions: 0 },
      draftTitle: 'Title',
      draftBody: 'Body',
      reviewArtifactIds: [],
      createdAt: '2026-10-14T00:00:00Z',
    },
  };
}

function topBarFixture(payload = gateFixture()): Parameters<typeof renderReadyTopBar>[0] {
  const decision: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Review',
    description: 'Review the captured work.',
    createdAt: '2026-10-14T00:00:00Z',
    actions: [EVIDENCE_ATTESTATION_ACTION],
  };
  return {
    payload,
    decision,
    publicationTarget: 'draft',
    pendingConfirm: EVIDENCE_ATTESTATION_ACTION.id,
    attestationReason: 'Inspected retained evidence.',
    attesting: true,
    acting: false,
    recovering: false,
    fileDiffAvailable: false,
    actionMessage: '',
    actionTone: '',
    openDiff: () => undefined,
    openReviewRequestModal: () => undefined,
    confirmAction: () => undefined,
  };
}

test('the existing top bar shows the shared attestation reason and explicit confirmation', () => {
  const text = litText(renderReadyTopBar(topBarFixture()));
  assert.match(text, /Reason for evidence policy attestation/);
  assert.match(text, /Confirm attestation and publish/);
  assert.doesNotMatch(text, /Integrity, source, CI and review checks remain required/);
});

test('the publication panel consumes the gateway skipped-review disclosure', () => {
  const input = topBarFixture();
  input.payload.gateSummary = {
    kind: 'publication',
    worker: { model: null, turns: null },
    review: {
      noCodeReview: true,
      reviews: [],
      passingReviews: 0,
      totalUnresolved: 0,
      didAnyReviewTriggerReWork: false,
    },
    tokens: {
      mainWorker: {
        model: null,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        total: 0,
        turns: 0,
      },
      reviews: [],
      byModel: [],
      familyTotalTokens: 0,
      perTurnDetailsAvailable: false,
    },
  };
  assert.match(litText(renderReadyTopBar(input)), /No code review ran/);
});

test('blocked visual claims show judgment rows and keep attestation out of the action row', () => {
  const payload = gateFixture();
  payload.gateReadiness = {
    state: 'not-ready',
    identity: { runId: 'run', generation: 1 },
    reasons: [
      {
        code: 'evidence-policy-unsatisfied',
        prerequisite: 'evidence',
        evidencePolicy: 'claim-verdict',
        message: 'Recorded claim verdicts do not satisfy publication policy.',
      },
    ],
  };
  const text = litText(
    renderReadyTopBar({
      ...topBarFixture(payload),
      pendingVisualClaimIds: ['AC-1', 'AC-2'],
      focusClaim: () => undefined,
    }),
  );
  assert.match(text, /AC-1.*AC-2.*2 criteria need a check/s);
  assert.doesNotMatch(text, /Reason for evidence policy attestation/);
  assert.match(text, /Review\s+evidence/);
});

const files: GitBranchDiffFile[] = [
  { path: 'src/gate.ts', status: 'M', additions: 4, deletions: 1 },
  { path: 'src/gate.test.ts', status: 'M', additions: 9, deletions: 0 },
  { path: 'src/panel.ts', status: 'A', additions: 12, deletions: 0 },
];

function tabBarText(diffCount: string): string {
  return litText(
    renderReadyTabBar({
      payload: {} as ReadyGatePayload,
      activeTab: 'diff',
      hideRecipeTab: false,
      evidenceCount: 0,
      qualityCount: 0,
      inputCount: 0,
      diffCount,
      setActiveTab: () => undefined,
    }),
  ).replace(/\s+/g, ' ');
}

function diffTabText(hideTests: boolean, source = files): string {
  const testFilter = new DiffTestFilterController(new FakeControllerHost());
  testFilter.hideTests = hideTests;
  return litText(
    renderReadyDiffTab({
      slotId: 'slot-1',
      diffLoading: false,
      diffError: '',
      diffFiles: source,
      testFilter,
      selectedFile: testFilter.split(source).visible[0]?.path ?? '',
      recovering: false,
      fileDiffLoading: false,
      fileDiff: '',
      selectFile: () => undefined,
    }),
  ).replace(/\s+/g, ' ');
}

test('renderReadyTabBar shows the filtered Diff count only while files are hidden', () => {
  assert.match(tabBarText('12'), /Diff \(12\)/);
  assert.match(tabBarText('5 of 12'), /Diff \(5 of 12\)/);
});

test('renderReadyDiffTab drops test pills and offers to show them when hiding', () => {
  const shown = diffTabText(false);
  assert.match(shown, /gate\.test\.ts/);
  assert.match(shown, /Hide tests/);

  const hidden = diffTabText(true);
  assert.doesNotMatch(hidden, /gate\.test\.ts/);
  assert.match(hidden, /gate\.ts/);
  assert.match(hidden, /panel\.ts/);
  assert.match(hidden, /Show tests \(1\)/);
});

test('renderReadyDiffTab keeps the toggle reachable when every changed file is a test', () => {
  const text = diffTabText(true, [files[1]]);
  assert.match(text, /Show tests \(1\)/);
  assert.match(text, /Only test files changed/);
  assert.doesNotMatch(text, /No changed files/);
});

test('action refusals remain visible outside collapsed package details', () => {
  const text = litText(
    renderReadyTopBar({
      payload: gateFixture(),
      publicationTarget: 'draft',
      pendingConfirm: null,
      acting: false,
      recovering: false,
      fileDiffAvailable: false,
      decision: {
        id: 'gate',
        type: 'engine_human_gate',
        title: 'Review',
        description: '',
        createdAt: '2026-10-16T00:00:00Z',
        actions: [{ id: 'request-review', label: 'Request review', style: 'secondary' }],
      },
      actionMessage: 'The displayed visual review snapshot changed.',
      actionTone: 'error',
      reviewProgress: 'Review in progress',
      openDiff: () => undefined,
      openReviewRequestModal: () => undefined,
      confirmAction: () => undefined,
    }),
  );
  assert.match(text, /role=alert/);
  assert.match(text, /rdy-request-review/);
  assert.match(text, /Review in progress/);
  assert.match(text, /The displayed visual review snapshot changed/);
  assert.doesNotMatch(text, /rdy-gate-details/);
});

test('the attestation form is primary when only code-review criteria remain', () => {
  const input = topBarFixture();
  input.attesting = false;
  input.pendingConfirm = null;
  input.claims = [
    {
      id: 'AC-2',
      text: 'Address has one configuration location',
      status: {
        id: 'AC-2',
        text: 'Address has one configuration location',
        proofMode: 'review',
        verdict: 'awaiting-review',
        evidence: [],
        recipeNodes: [],
      },
    },
  ];
  const text = litText(renderReadyTopBar(input));
  assert.match(text, /Reason for evidence policy attestation/);
  assert.match(text, /Attest evidence and approve/);
});
