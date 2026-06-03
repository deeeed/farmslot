import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PendingDecision, Run } from '@farmslot/protocol';

import { presentDecision } from './decision-presentation';
import { decisionRunId, enrichDecisionWithRunContext } from './decision-run-context';

test('decisionRunId resolves run ids from run metadata before context', () => {
  assert.equal(
    decisionRunId({
      context: { runId: 'context-run' },
      runMeta: {
        runId: 'meta-run',
        flowType: 'review-pr',
        ticketOrPr: 'ORG/repo#1',
      },
    }),
    'meta-run',
  );
  assert.equal(decisionRunId({ context: { runId: 'context-run' } }), 'context-run');
  assert.equal(decisionRunId({ context: { runId: ' ' } }), null);
});

test('enrichDecisionWithRunContext supplies run artifacts for retrospective evidence', () => {
  const decision: PendingDecision = {
    id: 'decision-retro',
    type: 'retrospective',
    slotId: null,
    title: 'Retro ready',
    description: 'Review retrospective',
    createdAt: '2026-01-01T00:00:00.000Z',
    context: { runId: 'run-retro' },
    actions: [{ id: 'save', label: 'Save', style: 'primary' }],
    payload: {
      kind: 'retrospective',
      whatThisIs: 'Retrospective summary',
      outcome: 'success',
      actionEffects: [],
    },
  };
  const run = {
    id: 'run-retro',
    familyId: 'family-retro',
    lane: 'production',
    flowType: 'review-pr',
    status: 'done',
    project: 'example-mobile',
    ticketOrPr: 'example-org/example-mobile#30095',
    slotId: 'runner-mobile-2',
    branch: 'feature/perps',
    taskFile: null,
    prNumber: 30095,
    steps: [
      {
        name: 'monitor',
        status: 'done',
        outputs: {
          artifacts: [
            { path: 'artifacts/before-market.png', purpose: 'screenshot-before' },
            { path: 'artifacts/after-market.png', purpose: 'screenshot-after' },
            { path: 'artifacts/summary.md', purpose: 'report' },
          ],
        },
      },
    ],
    decisions: [],
    metrics: { runner: 'codex', model: 'gpt-5.5' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    summary: 'Review perps provider',
  } as unknown as Run;

  const enriched = enrichDecisionWithRunContext(decision, run);
  assert.equal(enriched?.slotId, 'runner-mobile-2');
  assert.equal(enriched?.runMeta?.runner, 'codex');
  assert.equal(enriched?.runMeta?.model, 'gpt-5.5');

  const presentation = presentDecision(enriched!);
  assert.deepEqual(
    presentation.artifactManifest.map((artifact) => artifact.path),
    ['artifacts/before-market.png', 'artifacts/after-market.png', 'artifacts/summary.md'],
  );
  assert(
    presentation.highlights.some(
      (highlight) => highlight.label === 'Before→After' && highlight.value === '1 pair',
    ),
  );
});
