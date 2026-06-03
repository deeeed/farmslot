import { type PendingDecisionLike, presentDecision } from './decision-presentation';

export const readyGateDecisionFixture: PendingDecisionLike = {
  id: 'ready-1',
  type: 'engine_ready_gate',
  slotId: 'runner-browser-1',
  title: 'Ready to publish',
  description: 'Worker prepared a local PR package and needs approval.',
  context: { runId: 'run-ready-1', ticketOrPr: 'PROJ-100' },
  createdAt: '2026-05-16T03:00:00.000Z',
  runMeta: {
    runId: 'run-ready-1',
    flowType: 'dev',
    ticketOrPr: 'PROJ-100',
    branch: 'feat/mobile-review-cockpit',
    runner: 'claude',
    model: 'sonnet',
  },
  actions: [
    {
      id: 'approve',
      label: 'Approve',
      style: 'primary',
      description: 'Publish the prepared package after the reviewed evidence checks out.',
    },
    {
      id: 'request-changes',
      label: 'Request changes',
      style: 'secondary',
      description: 'Return the worker to implementation with feedback.',
    },
  ],
  payload: {
    kind: 'ready',
    prNumber: null,
    repo: 'farmslot',
    diffStat: { files: 4, additions: 180, deletions: 22 },
    workerReport: 'Implemented the mobile review cockpit and validated the happy path.',
    branch: 'feat/mobile-review-cockpit',
    slotId: 'runner-browser-1',
    artifactManifest: [
      { path: 'artifacts/pr-before.png', purpose: 'screenshot', sizeBytes: 1234 },
      { path: 'artifacts/pr-after.png', purpose: 'screenshot', sizeBytes: 1534 },
      { path: 'report.md', purpose: 'report', sizeBytes: 4567 },
    ],
    selfReviewVerdict: 'pass',
    acceptanceCriteria: ['Inbox shows gate evidence', 'Terminal nudge is confirmed'],
  },
};

export const reviewGateDecisionFixture: PendingDecisionLike = {
  id: 'review-1',
  type: 'review_comments',
  slotId: 'runner-browser-2',
  title: 'Review found issues',
  description: 'Independent review requires operator decision.',
  context: { runId: 'run-review-1', ticketOrPr: 'PR #123' },
  createdAt: '2026-05-16T03:05:00.000Z',
  runMeta: {
    runId: 'run-review-1',
    flowType: 'review-pr',
    ticketOrPr: 'PR #123',
    prNumber: 123,
    runner: 'codex',
    model: 'gpt-5.4',
  },
  actions: [
    { id: 'send-feedback', label: 'Send feedback', style: 'primary' },
    { id: 'override', label: 'Override', style: 'danger' },
  ],
  payload: {
    kind: 'review',
    prNumber: 123,
    repo: 'farmslot',
    recommendation: 'issues',
    reviewMd: 'Reviewer found one blocking issue in the action resolve flow.',
    lineComments: [
      { path: 'src/file.ts', line: 42, body: 'Handle the failure path.', severity: 'blocker' },
    ],
    artifactManifest: [{ path: 'review.md', purpose: 'review', sizeBytes: 1200 }],
    reviewSnapshot: {
      capturedAt: '2026-05-16T03:04:00.000Z',
      source: 'local-git',
      diffStat: { files: 2, additions: 45, deletions: 6 },
    },
  },
};

export const retrospectiveDecisionFixture: PendingDecisionLike = {
  id: 'retro-1',
  type: 'retrospective',
  slotId: null,
  title: 'Capture retrospective',
  description: 'Review learnings before closing the run family.',
  context: { runId: 'run-retro-1', ticketOrPr: 'PROJ-101' },
  createdAt: '2026-05-16T03:10:00.000Z',
  actions: [{ id: 'save', label: 'Save learning', style: 'primary' }],
  payload: {
    kind: 'retrospective',
    outcome: 'success',
    whatThisIs: 'Worker finished and produced one reusable learning.',
    selfReviewSummary: 'The worker validated the target flow and captured the reusable command.',
    actionEffects: [
      { actionId: 'save', summary: 'Persist learning to the family retro.' },
      { actionId: 'rerun', summary: 'No rerun needed because CI passed.' },
    ],
    reportExcerpt: 'Validation passed after a retry.',
    ciWatch: {
      result: 'passed',
      passed: 12,
      failed: 0,
      pending: 0,
      total: 12,
    },
    commentsTriageSummary: {
      total: 3,
      real: 2,
      falsePositive: 1,
      outOfScope: 0,
      fixed: 2,
      actionablePaths: ['src/terminal.ts'],
    },
  },
};

export const collisionDecisionFixture: PendingDecisionLike = {
  id: 'collision-1',
  type: 'collision_check',
  slotId: null,
  title: 'Existing task directory found',
  description: 'Pick a prior run or create a fresh task.',
  context: { runId: 'run-collision-1', ticketOrPr: 'PROJ-102' },
  createdAt: '2026-05-16T03:15:00.000Z',
  actions: [{ id: 'open-prior', label: 'Open prior run', style: 'primary' }],
  payload: {
    kind: 'collision',
    ticketSlug: 'proj-102',
    existingDirs: ['tasks/proj-102-mobile-review'],
    priorRunIds: ['run-old-1'],
  },
};

// Runtime fixture pass used by `yarn test:lib` to exercise representative
// payloads without requiring a live gateway or a Jest dependency in the Expo app.
export const decisionPresentationFixtures = [
  readyGateDecisionFixture,
  reviewGateDecisionFixture,
  retrospectiveDecisionFixture,
  collisionDecisionFixture,
].map(presentDecision);
