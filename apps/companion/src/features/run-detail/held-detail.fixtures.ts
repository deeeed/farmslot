import {
  HUMAN_GATE_DECISION_TYPE,
  type Run,
  type RunListRow,
  runListRow,
} from '@farmslot/protocol';

export const HELD_PACKAGE_HASH = 'pkg-held';
export const HELD_EVIDENCE_MANIFEST = [
  { path: 'evidence/before-login.png', purpose: 'before screenshot' },
  { path: 'evidence/after-login.png', purpose: 'after screenshot' },
];

/** A held run.get at its publish gate, with the package and step outputs a list row leaves out. */
export function heldGateRun(): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'human-gating',
    project: 'example-mobile',
    ticketOrPr: 'PR-1',
    summary: 'held run.get',
    slotId: 's1',
    branch: 'fix/run-1',
    taskFile: '/repo/TASK.md',
    steps: [
      { name: 'work', status: 'done', outputs: { transcript: 'worker transcript' } },
      { name: 'human-gate', status: 'running' },
    ],
    decisions: [
      {
        id: 'gate-1',
        type: HUMAN_GATE_DECISION_TYPE,
        title: 'Publish',
        description: 'Prepared package',
        createdAt: '2026-11-01T00:00:00.000Z',
        actions: [{ id: 'approve-publish', label: 'Approve', style: 'primary' }],
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          branch: 'fix/run-1',
          workerReport: 'Fixed the banner.',
          diffStat: { files: 1, additions: 4, deletions: 1 },
          acceptanceCriteria: ['Shows the banner'],
          prPackage: {
            id: 'package',
            packageHash: HELD_PACKAGE_HASH,
            headSha: 'head-1',
            artifactPath: 'artifacts/pr-package.json',
            branch: 'fix/run-1',
            diffStat: { files: 1, additions: 4, deletions: 1 },
            draftTitle: 'Fix the banner',
            draftBody: 'Body',
            evidenceManifest: HELD_EVIDENCE_MANIFEST,
            reviewArtifactIds: [],
            gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'Operator review' },
            publicationTarget: 'draft',
            publicationStatus: 'not_published',
            createdAt: '2026-11-01T00:00:00.000Z',
          },
        },
      },
    ],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:01:00.000Z',
  };
}

/** The run.list row the gateway serves after a later write moved the run to `status`. */
export function newerSlimRow(held: Run, status: Run['status'] = 'needs-decision'): RunListRow {
  return runListRow({
    ...held,
    status,
    summary: 'newer listed row',
    updatedAt: '2026-11-01T00:05:00.000Z',
  });
}
