import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { AcceptanceCriterionStatus, AcceptanceStatusLedger } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

import {
  acceptancePanelPresentation,
  evidenceLabel,
  renderAcceptancePanel,
} from './acceptance-panel.js';

function criterion(overrides: Partial<AcceptanceCriterionStatus> = {}): AcceptanceCriterionStatus {
  return {
    id: 'AC-1',
    text: 'The panel lists every criterion',
    verdict: 'proven',
    evidence: [],
    recipeNodes: [],
    updatedAt: '2026-09-19T10:00:00.000Z',
    ...overrides,
  };
}

function ledger(criteria: AcceptanceCriterionStatus[]): AcceptanceStatusLedger {
  return { schemaVersion: 1, criteria };
}

test('the header counts proven against the total', () => {
  const view = acceptancePanelPresentation(
    ledger([
      criterion({ id: 'AC-1', verdict: 'proven' }),
      criterion({ id: 'AC-2', verdict: 'weak' }),
      criterion({ id: 'AC-3', verdict: 'untestable' }),
    ]),
  );
  assert.equal(view.counts, '1/3 proven');
  assert.equal(view.countsTooltip, 'proven 1 · weak 1 · missing 0 · untestable 1 · no verdict 0');
  // A weak criterion is still open work, so the panel starts expanded.
  assert.equal(view.hasOpenCriteria, true);
});

test('a run whose criteria are all settled starts collapsed', () => {
  // Untestable counts as settled: it is a recorded decision, not open work.
  const view = acceptancePanelPresentation(
    ledger([
      criterion({ id: 'AC-1', verdict: 'proven' }),
      criterion({ id: 'AC-2', verdict: 'untestable' }),
    ]),
  );
  assert.equal(view.counts, '1/2 proven');
  assert.equal(view.hasOpenCriteria, false);
});

test('each row carries its id, verdict, proof mode, evidence and note', () => {
  const text = litText(
    renderAcceptancePanel(
      ledger([
        criterion({
          id: 'AC-1',
          text: 'Run detail shows verdicts',
          verdict: 'proven',
          proofMode: 'visual',
          evidence: ['artifacts/after-panel.png'],
          recipeNodes: ['assert-panel'],
        }),
        criterion({
          id: 'AC-2',
          text: 'Weak blocks the mark',
          verdict: 'weak',
          note: 'Unit test only.',
        }),
      ]),
      { evidenceHref: (evidencePath) => `/api/run-artifact?path=${evidencePath}` },
    ),
  );
  assert.match(text, /AC-1/);
  assert.match(text, /Run detail shows verdicts/);
  assert.match(text, /visual/);
  assert.match(text, /assert-panel/);
  // Evidence renders as a link on its basename, with the full path available.
  assert.match(text, /\/api\/run-artifact\?path=artifacts\/after-panel\.png/);
  assert.match(text, /after-panel\.png/);
  assert.match(text, /ac-row ac-weak/);
  assert.match(text, /Unit test only\./);
  // The verdict is the worker's claim, printed as recorded.
  assert.match(text, /data-ac-verdict=/);
});

test('a ledger with no criteria renders nothing at all', () => {
  assert.equal(litText(renderAcceptancePanel(ledger([]))), '');
});

test('a registered criterion with no verdict still gets a row, and counts against the total', () => {
  const registered = [
    { id: 'AC-1', text: 'Proven already' },
    { id: 'AC-2', text: 'Not judged yet' },
    { id: 'AC-3', text: 'Also not judged' },
  ];
  const view = acceptancePanelPresentation(
    ledger([criterion({ id: 'AC-1', text: 'Proven already' })]),
    registered,
  );
  // The ledger holds one entry; the run has three criteria.
  assert.equal(view.counts, '1/3 proven');
  assert.match(view.countsTooltip, /no verdict 2$/);
  assert.equal(view.hasOpenCriteria, true);

  const text = litText(
    renderAcceptancePanel(ledger([criterion({ id: 'AC-1', text: 'Proven already' })]), {
      criteria: registered,
    }),
  );
  assert.match(text, /AC-2/);
  assert.match(text, /Not judged yet/);
  assert.match(text, /no verdict/);
  assert.match(text, /ac-row ac-none/);
  // Nothing invents a verdict for an unjudged criterion.
  assert.doesNotMatch(text, /ac-row ac-missing/);
});

test('with only criteria and no ledger the panel still lists them as unjudged', () => {
  const text = litText(
    renderAcceptancePanel(ledger([]), {
      criteria: [
        { id: 'AC-1', text: 'First' },
        { id: 'AC-2', text: 'Second' },
      ],
    }),
  );
  assert.match(text, /0\/2 proven/);
  assert.match(text, /First/);
  assert.match(text, /Second/);
});

test('evidence shows its basename so a long path cannot break the row', () => {
  assert.equal(
    evidenceLabel('artifacts/recipe-run/screens/after-order-sheet.png'),
    'after-order-sheet.png',
  );
  assert.equal(evidenceLabel('after.png'), 'after.png');
});
