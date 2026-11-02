import assert from 'node:assert/strict';
import test from 'node:test';

import type { EvidenceReviewOccurrence } from '../src/evidence-review-model.js';
import {
  adjacentEvidenceReviewClaim,
  evidenceReviewToc,
  OTHER_PROOF_STEPS,
  proofStepGroups,
} from '../src/evidence-review-toc.js';

function step(traceIndex: number, proves: string[], ok = true): EvidenceReviewOccurrence {
  return {
    traceIndex,
    nodeId: `n${traceIndex}`,
    action: 'assert',
    intent: '',
    ok,
    proves,
    artifacts: [],
  };
}

test('proofStepGroups gathers each criterion in id order and leaves unproving steps last', () => {
  const groups = proofStepGroups([
    step(0, []),
    step(1, ['AC-10']),
    step(2, ['AC-2', 'AC-10'], false),
    step(3, []),
    step(4, ['AC-2']),
  ]);
  assert.deepEqual(
    groups.map(({ label, steps, failed }) => [label, steps.map((s) => s.traceIndex), failed]),
    [
      ['AC-2', [2, 4], 1],
      ['AC-10', [1, 2], 1],
      [OTHER_PROOF_STEPS, [0, 3], 0],
    ],
  );
});

/** A recording whose markers start at 1 s per trace index; trace 9 is not in the recording. */
function tocModel(claims: string[], occurrences: EvidenceReviewOccurrence[]) {
  const calls: [string, number, number | undefined][] = [];
  return {
    calls,
    model: {
      claims: claims.map((id) => ({ id })),
      occurrences,
      markerSeekMs(videoPath: string, traceIndex: number, _phase: 'start' | 'end', ms?: number) {
        calls.push([videoPath, traceIndex, ms]);
        return traceIndex === 9 ? null : traceIndex * 1000;
      },
    },
  };
}

test("evidenceReviewToc puts criteria in recording order with each one's first recorded step", () => {
  const { model, calls } = tocModel(
    ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
    [step(9, ['AC-1']), step(5, ['AC-1']), step(2, ['AC-2']), step(7, ['AC-3']), step(1, [])],
  );
  const toc = evidenceReviewToc(model, 'run.mp4', { mediaDurationMs: 60_000 });
  assert.deepEqual(
    toc.map(({ claim, startMs, steps }) => [claim.id, startMs, steps.map((s) => s.traceIndex)]),
    [
      ['AC-2', 2000, [2]],
      // AC-1's first step is not in the recording: its start is the next recorded step.
      ['AC-1', 5000, [9, 5]],
      ['AC-3', 7000, [7]],
      // No proving step at all: last, with nothing to seek to.
      ['AC-4', null, []],
    ],
  );
  assert.ok(calls.every(([path, , ms]) => path === 'run.mp4' && ms === 60_000));
  assert.deepEqual(
    evidenceReviewToc(model, 'run.mp4', { order: 'criteria' }).map(({ claim }) => claim.id),
    ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
  );
  assert.deepEqual(
    evidenceReviewToc(model, null).map(({ claim, startMs }) => [claim.id, startMs]),
    [
      ['AC-1', null],
      ['AC-2', null],
      ['AC-3', null],
      ['AC-4', null],
    ],
    'without a recording nothing has a moment',
  );
});

test('adjacentEvidenceReviewClaim steps through the table of contents and stops at the ends', () => {
  const { model } = tocModel(['AC-1', 'AC-2', 'AC-3'], [step(3, ['AC-1']), step(1, ['AC-2'])]);
  const toc = evidenceReviewToc(model, 'run.mp4');
  assert.deepEqual(
    toc.map(({ claim }) => claim.id),
    ['AC-2', 'AC-1', 'AC-3'],
  );
  assert.equal(adjacentEvidenceReviewClaim(toc, 'AC-2', 1), 'AC-1');
  assert.equal(adjacentEvidenceReviewClaim(toc, 'AC-1', -1), 'AC-2');
  assert.equal(adjacentEvidenceReviewClaim(toc, 'AC-2', -1), null);
  assert.equal(adjacentEvidenceReviewClaim(toc, 'AC-3', 1), null);
  assert.equal(adjacentEvidenceReviewClaim(toc, 'AC-9', 1), null);
});
