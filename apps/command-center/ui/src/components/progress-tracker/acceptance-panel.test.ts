import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { AcceptanceCriterionStatus, AcceptanceStatusLedger } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

import {
  type AcceptanceEvidenceOpen,
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

test('the header separates assessment progress from proven criteria', () => {
  const view = acceptancePanelPresentation(
    ledger([
      criterion({ id: 'AC-1', verdict: 'proven' }),
      criterion({ id: 'AC-2', verdict: 'weak' }),
      criterion({ id: 'AC-3', verdict: 'untestable' }),
    ]),
  );
  assert.equal(view.counts, '3/3 assessed · 1 proven');
  assert.equal(view.countsTooltip, 'proven 1 · weak 1 · missing 0 · untestable 1 · not assessed 0');
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
  assert.equal(view.counts, '2/2 assessed · 1 proven');
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
  assert.equal(view.counts, '1/3 assessed · 1 proven');
  assert.match(view.countsTooltip, /not assessed 2$/);
  assert.equal(view.hasOpenCriteria, true);

  const text = litText(
    renderAcceptancePanel(ledger([criterion({ id: 'AC-1', text: 'Proven already' })]), {
      criteria: registered,
    }),
  );
  assert.match(text, /AC-2/);
  assert.match(text, /Not judged yet/);
  assert.match(text, /not assessed/);
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
  assert.match(text, /0\/2 assessed/);
  assert.match(text, /First/);
  assert.match(text, /Second/);
});

test('an unreadable ledger says so instead of rendering nothing', () => {
  const text = litText(
    renderAcceptancePanel(ledger([]), {
      criteria: [{ id: 'AC-1', text: 'First' }],
      error: 'invalid artifacts/acceptance-status.json: Unexpected token',
    }),
  );
  assert.match(text, /ledger unreadable: invalid artifacts\/acceptance-status\.json/);
  assert.match(text, /acceptance-error/);
  // The criteria still list, so the operator sees what was supposed to be judged.
  assert.match(text, /AC-1/);

  // An error with nothing else known still renders the panel.
  const bare = litText(renderAcceptancePanel(ledger([]), { error: 'cannot read handoff.json' }));
  assert.match(bare, /ledger unreadable: cannot read handoff\.json/);
});

test('evidence shows its basename so a long path cannot break the row', () => {
  assert.equal(
    evidenceLabel('artifacts/recipe-run/screens/after-order-sheet.png'),
    'after-order-sheet.png',
  );
  assert.equal(evidenceLabel('after.png'), 'after.png');
});

test('manifest-linked criteria render as evidence linked, labelled, and never as proven', () => {
  const registered = [
    { id: 'AC-1', text: 'First' },
    { id: 'AC-2', text: 'Second' },
    { id: 'AC-3', text: 'Third' },
    { id: 'AC-4', text: 'Fourth' },
  ];
  const evidenceLinks = [
    { id: 'AC-1', evidence: ['artifacts/run/after-sheet.png'] },
    { id: 'AC-3', evidence: ['artifacts/trace.json'] },
  ];
  const text = litText(
    renderAcceptancePanel(ledger([]), {
      criteria: registered,
      evidenceLinks,
      evidenceHref: (evidencePath) => `/api/run-artifact?path=${evidencePath}`,
    }),
  );
  // Nothing is assessed: linked evidence is not a verdict.
  assert.match(text, /0\/4 assessed · 2 evidence linked/);
  assert.match(text, /from evidence manifest, not verdicts/);
  assert.match(text, /data-ac-id=AC-1\s+data-ac-verdict=evidence-linked/);
  assert.match(text, /ac-row ac-evidence-linked/);
  assert.match(text, /evidence linked/);
  assert.match(text, /\/api\/run-artifact\?path=artifacts\/run\/after-sheet\.png/);
  assert.match(text, /after-sheet\.png/);
  assert.equal(text.match(/ac-row ac-evidence-linked/g)?.length, 2);
  assert.equal(text.match(/ac-row ac-none/g)?.length, 2, 'AC-2 and AC-4 stay not assessed');
  assert.doesNotMatch(text, /ac-row ac-proven/);

  // A ledger always wins: links are ignored once any verdict is recorded.
  const withLedger = litText(
    renderAcceptancePanel(ledger([criterion({ id: 'AC-2', text: 'Second', verdict: 'weak' })]), {
      criteria: registered,
      evidenceLinks,
    }),
  );
  assert.doesNotMatch(withLedger, /evidence linked/);
  assert.doesNotMatch(withLedger, /acceptance-source/);
  assert.match(withLedger, /1\/4 assessed/);
});

/** Every `@click` handler in a template, in render order. */
function clickHandlers(value: unknown, found: Array<(event: MouseEvent) => void> = []) {
  if (Array.isArray(value)) {
    for (const entry of value) clickHandlers(entry, found);
    return found;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('strings' in value) ||
    !('values' in value)
  ) {
    return found;
  }
  const { strings, values } = value as { strings: readonly string[]; values: readonly unknown[] };
  values.forEach((entry, index) => {
    if (strings[index]?.trimEnd().endsWith('@click=') && typeof entry === 'function') {
      found.push(entry as (event: MouseEvent) => void);
    } else {
      clickHandlers(entry, found);
    }
  });
  return found;
}

function click(overrides: Partial<MouseEvent> = {}) {
  let prevented = false;
  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: () => {
      prevented = true;
    },
    ...overrides,
  } as MouseEvent;
  return { event, prevented: () => prevented };
}

test('clicking an evidence file opens the files of its criterion, in order, in the host viewer', () => {
  const windowOpen = Object.getOwnPropertyDescriptor(globalThis, 'open');
  const opened: string[] = [];
  Object.defineProperty(globalThis, 'open', {
    configurable: true,
    value: (url: string) => opened.push(url),
  });
  try {
    const calls: AcceptanceEvidenceOpen[] = [];
    const panel = renderAcceptancePanel(ledger([]), {
      criteria: [
        { id: 'AC-1', text: 'First' },
        { id: 'AC-2', text: 'Second' },
      ],
      evidenceLinks: [
        { id: 'AC-1', evidence: ['artifacts/evidence-ac1-a.png', 'artifacts/evidence-ac1-b.png'] },
        { id: 'AC-2', evidence: ['artifacts/teardown-final-state.png'] },
      ],
      evidenceHref: (evidencePath) => `/api/run-artifact?path=${evidencePath}`,
      openEvidence: (open) => calls.push(open),
    });
    const handlers = clickHandlers(panel);
    assert.equal(handlers.length, 3, 'one handler per evidence link');

    const second = click();
    handlers[1](second.event);
    assert.equal(second.prevented(), true, 'the browser does not follow the link');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].criterion.id, 'AC-1');
    assert.equal(calls[0].criterion.text, 'First');
    assert.deepEqual(calls[0].evidence, [
      'artifacts/evidence-ac1-a.png',
      'artifacts/evidence-ac1-b.png',
    ]);
    assert.equal(calls[0].index, 1);

    handlers[2](click().event);
    assert.equal(calls[1].criterion.id, 'AC-2');
    assert.deepEqual(calls[1].evidence, ['artifacts/teardown-final-state.png']);
    assert.equal(calls[1].index, 0);

    const modified = click({ metaKey: true });
    handlers[0](modified.event);
    assert.equal(modified.prevented(), false, 'cmd-click keeps the new-tab behaviour');
    assert.equal(calls.length, 2);
    assert.deepEqual(opened, [], 'nothing calls window.open');
  } finally {
    if (windowOpen) Object.defineProperty(globalThis, 'open', windowOpen);
    else delete (globalThis as { open?: unknown }).open;
  }
});
