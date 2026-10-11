import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { buildRerunAlongsideHref } from '../runs/run-detail-model.js';

import { parseDispatchWizardHash, syncReviewSequenceHash } from './dispatch-wizard-prefill.js';

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

test('dispatch hash round-trips all review dimensions and rejects invalid rows', () => {
  const sequence = [
    { runner: 'codex', model: 'gpt-6-astra', effort: 'ultra', mode: 'warm' as const },
    { runner: 'claude', model: null, effort: null, mode: 'cold' as const },
  ];
  const context = {
    reviewLineages: [{ repository: 'fixture/repo', prNumber: 1, reviewId: 'review-1' }, null],
  };
  const hash = syncReviewSequenceHash('#dispatch?flow=fix-bug&ticket=PROJ-1', sequence, context)!;
  assert.equal(parseDispatchWizardHash(hash, runners)?.ticketId, 'PROJ-1');
  assert.deepEqual(parseDispatchWizardHash(hash, runners)?.reviewSequence, sequence);
  assert.deepEqual(parseDispatchWizardHash(hash, runners)?.reviewSequenceContext, context);
  assert.equal(syncReviewSequenceHash(hash, []), '#dispatch?flow=fix-bug&ticket=PROJ-1');
  assert.throws(
    () =>
      parseDispatchWizardHash(
        '#dispatch?reviewSequence=' +
          encodeURIComponent(
            JSON.stringify([{ runner: 'same', model: null, effort: null, mode: 'cold' }]),
          ),
        runners,
      ),
    /runner/i,
  );
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

test('QA links preserve selected profile and JSON inputs', () => {
  const inputs = '{"scope":"release"}';
  const qa = parseDispatchWizardHash(
    `#dispatch?flow=qa&project=mobile&slot=runtime-1&qaProfileId=release&qaInputs=${encodeURIComponent(inputs)}`,
    runners,
  );
  assert.equal(qa?.flowType, 'qa');
  assert.equal(qa?.qaProfileId, 'release');
  assert.equal(qa?.qaInputs, inputs);
  assert.equal(qa?.slot, 'runtime-1');
  const staticLink = parseDispatchWizardHash(
    '#dispatch?flow=review-pr&reviewMachine=node-a',
    runners,
  );
  assert.equal(staticLink?.reviewMachine, 'node-a');
  const pinned = parseDispatchWizardHash('#dispatch?flow=review-pr&slot=runtime-1', runners);
  assert.match(pinned?.configurationError ?? '', /runtime slot/);
});
