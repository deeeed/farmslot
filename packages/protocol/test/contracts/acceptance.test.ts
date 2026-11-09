import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as portable from '../../scripts/acceptance.mjs';
import {
  acceptanceCriteriaMatch,
  registeredAcceptanceCriteria,
  ticketCriteriaAsRegistered,
} from '../../src/contracts/acceptance.js';
import type { AcceptanceRegistration } from '../../src/contracts/acceptance-registration.js';

const { rawTicketCriteria, ledgerCriteria } = JSON.parse(
  readFileSync(new URL('../fixtures/nested-list-criteria.json', import.meta.url), 'utf8'),
);
const normalized = ledgerCriteria.map(({ id, text }: { id: string; text: string }) => ({
  id,
  text,
}));
const raw = rawTicketCriteria.map((text: string, index: number) => ({
  id: `AC-${index + 1}`,
  text,
}));

test('nested-list ticket originals have exactly the existing task ledger text', () => {
  assert.deepEqual(ticketCriteriaAsRegistered(rawTicketCriteria), normalized);
  assert.equal(acceptanceCriteriaMatch(raw, normalized), false);
  assert.equal(acceptanceCriteriaMatch(normalized, raw), false);
});

test('raw retained registrations validate against raw tickets without rewriting originals', () => {
  const registration: AcceptanceRegistration = {
    schemaVersion: 1,
    runId: 'nested-list-run',
    revision: 1,
    intake: {
      provider: 'github',
      repository: 'example/app',
      prNumber: 1,
      headSha: 'a'.repeat(40),
      capturedAt: '2026-11-10T00:00:00Z',
    },
    original: raw,
    derived: [],
    units: [],
  };
  assert.deepEqual(ticketCriteriaAsRegistered(rawTicketCriteria, registration), raw);
  assert.equal(acceptanceCriteriaMatch(normalized, registration.original), false);
  const changed = [...rawTicketCriteria];
  changed[2] = changed[2].replace('2 kg', '3 kg');
  assert.throws(
    () => ticketCriteriaAsRegistered(changed, registration),
    /changed original criteria/,
  );
  assert.equal(acceptanceCriteriaMatch(registeredAcceptanceCriteria(changed), normalized), false);
  assert.equal(acceptanceCriteriaMatch(normalized, [...raw].reverse()), false);
});

test('empty entries keep compact positional ids', () => {
  assert.deepEqual(
    ticketCriteriaAsRegistered(['', '  ', '- First', '\n', '* [x] Second', '', '* [x] ']),
    [
      { id: 'AC-1', text: 'First' },
      { id: 'AC-2', text: 'Second' },
    ],
  );
});

test('the portable normalizer preserves task init marker, whitespace and blank-line rules', () => {
  assert.deepEqual(
    portable.normalizeAcceptanceCriteria([
      ' - [ ] First\n\n  * [X] Child\n\t continuation ',
      '',
      '* [x] ',
      '- - Keep one marker',
    ]),
    ['First\nChild\ncontinuation', '- Keep one marker'],
  );
});

test('single-pass markers retain raw registration compatibility', () => {
  const original = [{ id: 'AC-1', text: '- - Keep one marker' }];
  const registration = { schemaVersion: 1, revision: 1, original, derived: [], units: [] };
  const criteria = ticketCriteriaAsRegistered(original.map(({ text }) => text));
  assert.deepEqual(criteria, [{ id: 'AC-1', text: '- Keep one marker' }]);
  assert.deepEqual(
    portable.registeredAcceptanceCriteria(
      original.map(({ text }) => text),
      registration,
    ),
    original,
  );
  assert.equal(acceptanceCriteriaMatch(criteria, original), false);
  assert.equal(acceptanceCriteriaMatch(original, criteria), false);
});

test('stored definitions retain their bytes and checkbox obligations remain distinct', () => {
  const first = 'Default selection:\n- [x] Active\n- [ ] Archived';
  const reversed = 'Default selection:\n- [ ] Active\n- [x] Archived';
  assert.deepEqual(
    portable.normalizeAcceptanceCriteria([first]),
    portable.normalizeAcceptanceCriteria([reversed]),
  );
  assert.equal(
    acceptanceCriteriaMatch([{ id: 'AC-2', text: first }], [{ id: 'AC-2', text: reversed }]),
    false,
  );
  assert.deepEqual(registeredAcceptanceCriteria(['- Keep one marker']), [
    { id: 'AC-1', text: '- Keep one marker' },
  ]);
});

test('raw tickets validate raw or normalized registration originals exactly', () => {
  const raw = ['- - Keep one marker'];
  for (const text of [raw[0], '- Keep one marker']) {
    const original = [{ id: 'AC-1', text }];
    const registration = { schemaVersion: 1, revision: 1, original, derived: [], units: [] };
    assert.deepEqual(portable.ticketCriteriaAsRegistered(raw, registration), original);
    assert.throws(
      () => portable.ticketCriteriaAsRegistered(['- - Changed marker'], registration),
      /changed original criteria/,
    );
  }
});
