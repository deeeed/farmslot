import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  type AcceptanceStatusLedger,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
} from '@farmslot/protocol';

import {
  acceptanceEvidenceHref,
  acceptanceEvidenceStrip,
  acceptanceEvidenceViewer,
  recordedEvidenceKey,
  recordingAcceptanceReview,
} from './acceptance-evidence';
import { DECISION_EVIDENCE_RECIPE_RUN_PARAM } from './artifact-url';
import { acceptanceLedgerView } from './task-progress-view';

function view() {
  const ledger: AcceptanceStatusLedger = {
    schemaVersion: 1,
    criteria: [
      {
        id: 'AC-1',
        text: 'Approve stays disabled',
        verdict: 'proven',
        proofMode: 'mixed',
        evidence: [
          'artifacts/after-gate.png',
          'artifacts/after.mp4',
          'artifacts/gate-run.json',
          'artifacts/gate.log',
        ],
        recipeNodes: ['capture-gate', 'verify-hold'],
        updatedAt: '2026-10-11T12:00:00.000Z',
      },
      {
        id: 'AC-2',
        text: 'Evidence opens the viewer',
        verdict: 'weak',
        evidence: ['artifacts/after-gate.png', 'artifacts/after-viewer.png'],
        recipeNodes: [],
        updatedAt: '2026-10-11T12:01:00.000Z',
      },
    ],
  };
  return acceptanceLedgerView(ledger, [
    { id: 'AC-1', text: 'Approve stays disabled' },
    { id: 'AC-2', text: 'Evidence opens the viewer' },
    { id: 'AC-3', text: 'Not judged yet' },
  ]);
}

const urlFor = (path: string) => `http://gw/api/run-artifact?path=${path}`;

test('an evidence entry opens on itself and swipes through only its criterion', () => {
  const viewer = acceptanceEvidenceViewer(view().rows[0], 'artifacts/after.mp4', urlFor);
  assert.ok(viewer);
  assert.equal(viewer.initialIndex, 1);
  assert.deepEqual(
    viewer.items.map((item) => [item.title, item.mediaType]),
    [
      ['after-gate.png', 'image'],
      ['after.mp4', 'video'],
      ['gate-run.json', 'document'],
      // Anything that is not an image or a video renders as text.
      ['gate.log', 'document'],
    ],
  );
  assert.equal(viewer.items[0].uri, urlFor('artifacts/after-gate.png'));
  // The header carries the criterion's verdict, proof mode and recipe nodes.
  assert.equal(viewer.items[1].detail, 'AC-1 · proven · mixed · node capture-gate, verify-hold');
});

test('the header says what the ledger lacks instead of inventing it', () => {
  const viewer = acceptanceEvidenceViewer(view().rows[1], 'artifacts/after-viewer.png', urlFor);
  assert.ok(viewer);
  assert.equal(viewer.initialIndex, 1);
  assert.equal(viewer.items[0].detail, 'AC-2 · weak · no proof mode · no recipe node');
});

test('a path that is not evidence of the criterion does not open under its verdict', () => {
  assert.equal(acceptanceEvidenceViewer(view().rows[1], 'artifacts/after.mp4', urlFor), null);
  assert.equal(acceptanceEvidenceViewer(view().rows[2], 'artifacts/after-gate.png', urlFor), null);
});

test('the evidence strip lists each file once, under the first criterion citing it', () => {
  assert.deepEqual(
    acceptanceEvidenceStrip(view()).map((item) => [item.criterionId, item.name]),
    [
      ['AC-1', 'after-gate.png'],
      ['AC-1', 'after.mp4'],
      ['AC-1', 'gate-run.json'],
      ['AC-1', 'gate.log'],
      ['AC-2', 'after-viewer.png'],
    ],
  );
});

test('a repeated ledger path is one evidence item', () => {
  const row = acceptanceLedgerView({
    schemaVersion: 1,
    criteria: [
      {
        id: 'AC-1',
        text: 'Repeated',
        verdict: 'proven',
        evidence: ['artifacts/a.png', 'artifacts/a.png', 'artifacts/b.png'],
        recipeNodes: [],
        updatedAt: '2026-10-11T12:00:00.000Z',
      },
    ],
  }).rows[0];
  assert.deepEqual(
    row.evidence.map((entry) => entry.name),
    ['a.png', 'b.png'],
  );
  assert.equal(acceptanceEvidenceViewer(row, 'artifacts/b.png', urlFor)?.initialIndex, 1);
});

test('the evidence route opens the run files viewer on the task artifact', () => {
  assert.deepEqual(acceptanceEvidenceHref('run-1', 'AC-2', 'artifacts/after-viewer.png'), {
    pathname: '/evidence/[runId]',
    params: {
      runId: 'run-1',
      ac: 'AC-2',
      evidence: 'artifacts/after-viewer.png',
      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
    },
  });
});

test('verdicts over a recording act only on the evidence it opened on', async () => {
  const recorded: string[] = [];
  const live = (key: string | null) => ({
    rows: [],
    evidenceKey: key,
    record: async (id: string) => {
      recorded.push(`${key}:${id}`);
    },
  });
  // A verdict refreshes the rows and callback but keeps the evidence: the next one still acts.
  const first = recordingAcceptanceReview(live('A'), 'A');
  await first?.record?.('AC-1', 'confirmed');
  const second = recordingAcceptanceReview(live('A'), 'A');
  assert.equal(second?.stale, undefined);
  await second?.record?.('AC-2', 'rejected');
  assert.deepEqual(recorded, ['A:AC-1', 'A:AC-2']);
  // Newer evidence while the recording stays on the old files: no verdicts, a reopen hint.
  const replaced = recordingAcceptanceReview(live('B'), 'A');
  assert.equal(replaced?.record, undefined);
  assert.equal(replaced?.stale, true);
  // A recording opened without knowing its evidence keeps the live review as it is.
  assert.equal(recordingAcceptanceReview(live('B'), undefined)?.stale, undefined);
  assert.equal(recordingAcceptanceReview(undefined, 'A'), undefined);
});

test('the evidence key comes only from a verified read, never a throw', () => {
  const { input }: { input: RecordedEvidencePackageInput } = JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const key = recordedEvidenceKey({ input, errors: [] });
  assert.equal(typeof key, 'string');
  // A pruned retained file: the package still lists it, without a digest, and the read says so.
  const [pruned] = Object.keys(input.artifactDigests);
  assert.ok(pruned);
  const { [pruned]: _dropped, ...artifactDigests } = input.artifactDigests;
  const unverifiable = {
    ...input,
    artifactPaths: input.artifactPaths ?? Object.keys(input.artifactDigests),
    artifactDigests,
  };
  assert.throws(() => recordedEvidenceClosureIdentity(unverifiable));
  assert.equal(
    recordedEvidenceKey({ input: unverifiable, errors: ['Retained artifact is missing'] }),
    null,
  );
  assert.equal(
    recordedEvidenceKey({ input, errors: [], failureCode: 'evidence-package-unverifiable' }),
    null,
  );
  assert.equal(recordedEvidenceKey({ input: { ...input, claims: undefined }, errors: [] }), null);
  assert.equal(recordedEvidenceKey(undefined), null);
});

test('Review evidence opens on a path of the same evidence read it came from', () => {
  // The shape of a done run with a pending output review (sanitized): the run screen reads
  // the review's snapshot, which maps package files under artifacts/recipe-runs/run-2/;
  // the run-scoped read maps the same files under artifacts/.
  const { input }: { input: RecordedEvidencePackageInput } = JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const read = (artifactPrefix: string) =>
    createEvidenceReviewModel({ package: input, artifactPrefix, packagePath: 'recipe-runs/run-2' });
  const snapshot = read('artifacts/recipe-runs/run-2/');
  const runScoped = read('artifacts/');
  const claimId = snapshot.claims.find((claim) => snapshot.claimFocusPath(claim.id))?.id;
  assert.ok(claimId, 'the fixture has a criterion with evidence to open');
  const focus = snapshot.claimFocusPath(claimId)!;
  assert.ok(focus.startsWith('artifacts/recipe-runs/run-2/'));
  const ledger: AcceptanceStatusLedger = { schemaVersion: 1, criteria: [] };
  const row = (model: typeof snapshot) =>
    acceptanceLedgerView(ledger, model.claims, [], model).rows.find(
      (candidate) => candidate.criterion.id === claimId,
    )!;
  const opened = acceptanceEvidenceViewer(row(snapshot), focus, (path) => path, snapshot);
  assert.equal(opened?.items[opened.initialIndex]?.path, focus);
  // The failure the phone showed: the same path against the other read is not its evidence.
  assert.equal(
    acceptanceEvidenceViewer(row(runScoped), focus, (path) => path, runScoped),
    null,
  );
});
