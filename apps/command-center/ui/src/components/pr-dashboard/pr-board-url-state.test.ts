import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import {
  prBoardUrlStateFromHash,
  prBoardUrlStateHash,
  prCompleteDispatchHash,
} from './pr-board-url-state.js';

const prs = [
  { repo: 'org/app', pr: 7 } as PRStatus,
  { repo: 'org/cli', pr: 8 } as PRStatus,
  { repo: 'org/other', pr: 7 } as PRStatus,
];

test('PR board URL state parses repo-qualified selection and modal state', () => {
  assert.deepEqual(
    prBoardUrlStateFromHash(prs, '#prs?repo=org%2Fapp&pr=7&view=modal&layout=list'),
    {
      layout: 'list',
      selectedPr: { repo: 'org/app', pr: 7 },
      modalPr: { repo: 'org/app', pr: 7 },
    },
  );
});

test('PR board URL state resolves legacy bare PR only when unique', () => {
  assert.deepEqual(prBoardUrlStateFromHash(prs, '#prs?pr=8&view=detail'), {
    layout: undefined,
    selectedPr: { repo: 'org/cli', pr: 8 },
    modalPr: null,
  });
  assert.deepEqual(prBoardUrlStateFromHash(prs, '#prs?pr=7&view=detail'), {
    layout: undefined,
    selectedPr: null,
    modalPr: null,
  });
});

test('PR board hash updates preserve unrelated params and invalid routes are ignored', () => {
  assert.equal(
    prBoardUrlStateHash(
      { selectedPr: { repo: 'org/app', pr: 7 }, modalPr: null, layout: 'list' },
      '#prs?projects=web&machines=m1&repo=old&pr=1',
    ),
    '#prs?projects=web&machines=m1&repo=org%2Fapp&pr=7&view=detail&layout=list',
  );
  assert.equal(
    prBoardUrlStateHash({ selectedPr: null, modalPr: null, layout: 'board' }, '#fleet?pr=7'),
    null,
  );
});

test('PR complete dispatch hash preserves board global filters', () => {
  assert.equal(
    prCompleteDispatchHash(
      { repo: 'org/app', pr: 7, project: 'web' },
      '#prs?projects=web&machines=m1&repo=org%2Fapp&pr=7',
    ),
    '#dispatch?flow=pr-complete&ticket=org%2Fapp%237&project=web&projects=web&machines=m1',
  );
});
