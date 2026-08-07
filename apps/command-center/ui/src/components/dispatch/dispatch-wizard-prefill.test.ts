import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDispatchWizardHash,
  shouldUsePrefillSlot,
  syncPublicationReviewsHash,
} from './dispatch-wizard-prefill.js';

const runners = ['claude', 'codex', 'opencode'] as const;

test('parseDispatchWizardHash reads dispatch URL prefill and publication reviews', () => {
  const result = parseDispatchWizardHash(
    '#dispatch?flow=fix-bug&ticket=PROJ-1&project=mobile&slot=runner-a-mobile-1&publicationReviews=codex:static-code,claude:full-live',
    runners,
  );
  assert.equal(result?.flowType, 'fix-bug');
  assert.equal(result?.ticketId, 'PROJ-1');
  assert.equal(result?.project, 'mobile');
  assert.equal(result?.slot, 'runner-a-mobile-1');
  assert.deepEqual(result?.publicationReviewLoops, [
    { id: 1, runner: 'codex', validationDepth: 'static-code' },
    { id: 2, runner: 'claude', validationDepth: 'full-live' },
  ]);
});

test('parseDispatchWizardHash ignores invalid flow and unsupported review runners', () => {
  const result = parseDispatchWizardHash(
    '#dispatch?flow=unsafe&publicationReviews=missing:full-live,codex',
    runners,
  );
  assert.equal(result?.flowType, undefined);
  assert.deepEqual(result?.publicationReviewLoops, [
    { id: 1, runner: 'codex', validationDepth: 'static-code' },
  ]);
});

test('parseDispatchWizardHash returns sanitized hash when legacy startRef prefill appears', () => {
  const result = parseDispatchWizardHash(
    '#dispatch?flow=dev&ticket=PROJ-1&startRef=abc&keep=1&start_ref=old',
    runners,
  );
  assert.equal(result?.startRefRedirectHash, '#dispatch?flow=dev&ticket=PROJ-1&keep=1');
});

test('parseDispatchWizardHash reads comparison lane prefill', () => {
  const result = parseDispatchWizardHash(
    '#dispatch?lane=comparison&familyId=fam&variant=codex-gpt&parentRunId=run-1&runner=codex&model=gpt-5.4',
    runners,
  );
  assert.deepEqual(result?.comparison, {
    familyId: 'fam',
    variant: 'codex-gpt',
    parentRunId: 'run-1',
    runner: 'codex',
    model: 'gpt-5.4',
  });
  assert.equal(result?.comparisonIntent, false);
});

test('parseDispatchWizardHash reads comparison intent without baseline prefill', () => {
  const result = parseDispatchWizardHash('#dispatch?machines=macwork&intent=comparison', runners);
  assert.equal(result?.comparisonIntent, true);
  assert.equal(result?.comparison, undefined);
});

test('syncPublicationReviewsHash preserves unrelated query params', () => {
  const next = syncPublicationReviewsHash('#dispatch?flow=fix-bug&ticket=PROJ-1', [
    { id: 7, runner: 'codex', validationDepth: 'static-code' },
  ]);
  assert.equal(next, '#dispatch?flow=fix-bug&ticket=PROJ-1&publicationReviews=codex%3Astatic-code');
  assert.equal(
    syncPublicationReviewsHash('#dispatch?flow=fix-bug&publicationReviews=codex', []),
    '#dispatch?flow=fix-bug',
  );
});

test('shouldUsePrefillSlot respects active machine filters', () => {
  assert.equal(shouldUsePrefillSlot('runner-a-mobile-1', []), true);
  assert.equal(shouldUsePrefillSlot('runner-a-mobile-1', ['runner-a']), true);
  assert.equal(shouldUsePrefillSlot('runner-a-mobile-1', ['vegeta']), false);
  assert.equal(shouldUsePrefillSlot(undefined, ['runner-a']), false);
});
