import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilityStep,
  RunStepStatus,
} from '@farmslot/protocol';
import { DEFAULT_GRADER_ID } from '@farmslot/protocol';

import {
  canGradeFamilyRun,
  createGradeDraft,
  deriveSemantic,
  familyHasConvergedGood,
  hasFailingGradeVerdict,
  humanGradeFromDraft,
  updateGradeDraftNote,
  updateGradeDraftVerdict,
} from './family-observability-grading.js';

function run(
  overrides: Partial<FamilyObservabilityRunSummary> = {},
): FamilyObservabilityRunSummary {
  return {
    runId: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'farm',
    branch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    proofTargets: [
      { id: 'ac1', target: 'First AC' },
      { id: 'ac2', target: 'Second AC' },
    ],
    ...overrides,
  } as FamilyObservabilityRunSummary;
}

function monitorStep(status: RunStepStatus): FamilyObservabilityStep {
  return {
    runId: 'run-1',
    stepName: 'monitor',
    status,
    artifacts: [],
    learnings: [],
    missingData: [],
  };
}

test('deriveSemantic summarizes proof target verdict maps', () => {
  assert.equal(deriveSemantic(new Map()), '');
  assert.equal(
    deriveSemantic(
      new Map([
        ['ac1', { verdict: 'pass' }],
        ['ac2', { verdict: 'pass' }],
      ]),
    ),
    'good',
  );
  assert.equal(
    deriveSemantic(
      new Map([
        ['ac1', { verdict: 'pass' }],
        ['ac2', {}],
      ]),
    ),
    'ok',
  );
  assert.equal(deriveSemantic(new Map([['ac1', { verdict: 'fail' }]])), 'bad');
});

test('canGradeFamilyRun requires a terminal run with a non-pending monitor step', () => {
  assert.equal(
    canGradeFamilyRun(
      run({
        status: 'done',
        steps: [monitorStep('done')],
      }),
    ),
    true,
  );
  assert.equal(
    canGradeFamilyRun(
      run({
        status: 'monitoring',
        steps: [monitorStep('done')],
      }),
    ),
    false,
  );
  assert.equal(
    canGradeFamilyRun(
      run({
        status: 'failed',
        steps: [monitorStep('pending')],
      }),
    ),
    false,
  );
});

test('createGradeDraft seeds proof targets and detects semantic overrides', () => {
  const draft = createGradeDraft(
    run({
      humanGrade: {
        recipe_semantic: 'ok',
        reasoning: 'Manual override',
        graded_by: 'arthur',
        graded_at: '2026-01-01T00:00:00.000Z',
        proof_target_verdicts: [
          { id: 'ac1', target: 'First AC', verdict: 'pass' },
          { id: 'ac2', target: 'Second AC', verdict: 'pass' },
        ],
      },
    }),
  );

  assert.equal(draft.semantic, 'ok');
  assert.equal(draft.reasoning, 'Manual override');
  assert.equal(draft.overridden, true);
  assert.equal(draft.verdicts.get('ac1')?.verdict, 'pass');
});

test('grade draft updates recompute semantic unless overridden', () => {
  const draft = createGradeDraft(run());
  const first = updateGradeDraftVerdict(draft, 'ac1', 'pass');
  assert.equal(first.semantic, 'ok');
  const second = updateGradeDraftVerdict(first, 'ac2', 'pass');
  assert.equal(second.semantic, 'good');
  const failed = updateGradeDraftVerdict(second, 'ac2', 'fail');
  assert.equal(failed.semantic, 'bad');
  assert.equal(hasFailingGradeVerdict(failed), true);

  const overridden = { ...second, semantic: 'ok' as const, overridden: true };
  assert.equal(updateGradeDraftVerdict(overridden, 'ac2', 'fail').semantic, 'ok');
});

test('humanGradeFromDraft trims verdict notes and preserves grader metadata', () => {
  const draft = updateGradeDraftNote(
    updateGradeDraftVerdict(createGradeDraft(run()), 'ac1', 'pass'),
    'ac1',
    ' Looks good ',
  );
  const grade = humanGradeFromDraft({ ...draft, semantic: 'good' }, '2026-02-03T00:00:00.000Z');

  assert.equal(grade.recipe_semantic, 'good');
  assert.equal(grade.graded_by, DEFAULT_GRADER_ID);
  assert.equal(grade.graded_at, '2026-02-03T00:00:00.000Z');
  assert.deepEqual(grade.proof_target_verdicts, [
    { id: 'ac1', target: 'First AC', verdict: 'pass', note: 'Looks good' },
  ]);
});

test('familyHasConvergedGood requires graded good runs without failed targets', () => {
  assert.equal(familyHasConvergedGood([]), false);
  assert.equal(
    familyHasConvergedGood([
      {
        humanGrade: {
          recipe_semantic: 'good',
          reasoning: 'solid',
          graded_by: 'operator',
          graded_at: '2026-05-01T00:00:00.000Z',
          proof_target_verdicts: [{ id: 'target-1', target: 'works', verdict: 'pass' }],
        },
      } as FamilyObservabilityRunSummary,
    ]),
    true,
  );
  assert.equal(
    familyHasConvergedGood([
      {
        humanGrade: {
          recipe_semantic: 'good',
          reasoning: 'has a failure',
          graded_by: 'operator',
          graded_at: '2026-05-01T00:00:00.000Z',
          proof_target_verdicts: [{ id: 'target-1', target: 'works', verdict: 'fail' }],
        },
      } as FamilyObservabilityRunSummary,
    ]),
    false,
  );
});
