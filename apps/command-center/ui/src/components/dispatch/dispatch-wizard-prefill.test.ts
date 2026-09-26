import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { buildRerunAlongsideHref } from '../runs/run-detail-model.js';

import { parseDispatchWizardHash, syncPublicationReviewsHash } from './dispatch-wizard-prefill.js';

const runners = ['claude', 'codex', 'opencode'] as const;

test('comparison links round-trip the baseline transport and an explicit terminal override', () => {
  const parent = {
    id: 'native-parent',
    familyId: 'family',
    flowType: 'dev',
    project: 'fixture',
    ticketOrPr: 'DEV-1',
    transport: 'native',
    metrics: { runner: 'codex', model: 'gpt-6-astra' },
  } as Run;
  const href = buildRerunAlongsideHref(parent, '');
  assert.equal(parseDispatchWizardHash(href, runners)?.transport, 'native');
  assert.equal(
    parseDispatchWizardHash(href.replace('transport=native', 'transport=tmux'), runners)?.transport,
    'tmux',
  );
  assert.equal(
    parseDispatchWizardHash('#dispatch?flow=dev&transport=unknown', runners)?.transport,
    undefined,
  );
});

test('parseDispatchWizardHash reads publication review runners and keeps legacy live links static', () => {
  const result = parseDispatchWizardHash(
    '#dispatch?flow=fix-bug&ticket=PROJ-1&project=mobile&slot=runner-a-mobile-1&publicationReviews=codex:static-code,claude:full-live',
    runners,
  );
  assert.equal(result?.flowType, 'fix-bug');
  assert.equal(result?.ticketId, 'PROJ-1');
  assert.equal(result?.project, 'mobile');
  assert.equal(result?.slot, 'runner-a-mobile-1');
  assert.deepEqual(result?.publicationReviewLoops, [
    { id: 1, runner: 'codex' },
    { id: 2, runner: 'claude' },
  ]);
});

test('parseDispatchWizardHash ignores invalid flow and unsupported review runners', () => {
  const result = parseDispatchWizardHash(
    '#dispatch?flow=unsafe&publicationReviews=missing:full-live,codex',
    runners,
  );
  assert.equal(result?.flowType, undefined);
  assert.deepEqual(result?.publicationReviewLoops, [{ id: 1, runner: 'codex' }]);
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
    { id: 7, runner: 'codex' },
  ]);
  assert.equal(next, '#dispatch?flow=fix-bug&ticket=PROJ-1&publicationReviews=codex');
  assert.equal(
    syncPublicationReviewsHash('#dispatch?flow=fix-bug&publicationReviews=codex', []),
    '#dispatch?flow=fix-bug',
  );
});

test('QA links preserve selected profile/JSON and legacy full-live links open the QA flow', () => {
  const inputs = '{"scope":"release"}';
  const qa = parseDispatchWizardHash(
    `#dispatch?flow=qa&project=mobile&slot=runtime-1&qaProfileId=release&qaInputs=${encodeURIComponent(inputs)}`,
    runners,
  );
  assert.equal(qa?.flowType, 'qa');
  assert.equal(qa?.qaProfileId, 'release');
  assert.equal(qa?.qaInputs, inputs);
  assert.equal(qa?.slot, 'runtime-1');
  const legacy = parseDispatchWizardHash(
    '#dispatch?flow=review-pr&validationDepth=full-live&slot=runtime-1',
    runners,
  );
  assert.equal(legacy?.flowType, 'qa');
  assert.equal(legacy?.slot, 'runtime-1');
  const staticLink = parseDispatchWizardHash(
    '#dispatch?flow=review-pr&reviewMachine=node-a',
    runners,
  );
  assert.equal(staticLink?.reviewMachine, 'node-a');
  const pinned = parseDispatchWizardHash('#dispatch?flow=review-pr&slot=runtime-1', runners);
  assert.match(pinned?.configurationError ?? '', /runtime slot/);
});
