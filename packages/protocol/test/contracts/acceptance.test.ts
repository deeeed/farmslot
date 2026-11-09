import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as portable from '../../scripts/acceptance.mjs';
import {
  acceptanceCriteriaMatch,
  registeredAcceptanceCriteria,
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
  assert.deepEqual(registeredAcceptanceCriteria(rawTicketCriteria), normalized);
  assert.equal(acceptanceCriteriaMatch(raw, normalized), true);
  assert.equal(acceptanceCriteriaMatch(normalized, raw), true);
});

test('raw retained registrations still match normalized handoffs without rewriting originals', () => {
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
  assert.deepEqual(
    registeredAcceptanceCriteria(
      normalized.map(({ text }: { text: string }) => text),
      registration,
    ),
    raw,
  );
  assert.equal(acceptanceCriteriaMatch(normalized, registration.original), true);
  const changed = [...rawTicketCriteria];
  changed[2] = changed[2].replace('2 kg', '3 kg');
  assert.throws(
    () => registeredAcceptanceCriteria(changed, registration),
    /changed original criteria/,
  );
  assert.equal(acceptanceCriteriaMatch(registeredAcceptanceCriteria(changed), normalized), false);
  assert.equal(acceptanceCriteriaMatch(normalized, [...raw].reverse()), false);
});

test('empty entries keep compact positional ids', () => {
  assert.deepEqual(registeredAcceptanceCriteria(['', '  ', '- First', '\n', '* [x] Second', '']), [
    { id: 'AC-1', text: 'First' },
    { id: 'AC-2', text: 'Second' },
  ]);
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
  const criteria = registeredAcceptanceCriteria(original.map(({ text }) => text));
  assert.deepEqual(criteria, [{ id: 'AC-1', text: '- Keep one marker' }]);
  assert.deepEqual(
    portable.registeredAcceptanceCriteria(
      original.map(({ text }) => text),
      registration,
    ),
    original,
  );
  assert.equal(acceptanceCriteriaMatch(criteria, original), true);
  assert.equal(acceptanceCriteriaMatch(original, criteria), true);
});
