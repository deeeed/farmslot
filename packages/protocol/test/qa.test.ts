import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prReviewPurpose, samePRReviewOptions } from '../src/contracts/pr-rules.js';
import {
  assertStaticReviewLoopRequests,
  type ProjectQaConfig,
  qaInputFieldValue,
  resolveReviewQaDispatch,
  selectQaProfile,
  validateQaConfig,
} from '../src/contracts/qa.js';
import { assertPRReviewOptions } from '../src/integrations/pr-rule-config.js';

const config: ProjectQaConfig = {
  default_profile: 'changes',
  profiles: [
    {
      id: 'changes',
      title: 'Validate changes',
      template_id: 'validation/autonomous',
      inputs: { scope: { kind: 'window', hours: 24 }, domain: 'payments' },
    },
    { id: 'candidate', title: 'Validate candidate', template_id: 'candidate/validation' },
  ],
};

test('farm-defined input fields validate defaults, choices and required values at admission', () => {
  const farm: ProjectQaConfig = {
    default_profile: 'custom',
    profiles: [
      {
        id: 'custom',
        title: 'Custom validation',
        template_id: 'team/check',
        inputs: { range: { hours: 24 }, enabled: false, target: 'main' },
        input_fields: [
          { path: 'range.hours', title: 'Hours', type: 'number', required: true },
          {
            path: 'lane',
            title: 'Proof lane',
            type: 'select',
            required: true,
            options: [{ value: 'source', title: 'Development' }],
          },
          { path: 'enabled', title: 'Enabled', type: 'boolean' },
          { path: 'target', title: 'Target', type: 'text', required: true },
        ],
      },
    ],
  };
  assert.doesNotThrow(() => validateQaConfig(farm));
  assert.throws(() => selectQaProfile(farm), /Proof lane is required/);
  const selected = selectQaProfile(farm, undefined, { lane: 'source' });
  assert.equal(qaInputFieldValue(selected.inputs, 'range.hours'), 24);
  assert.equal(selected.inputs.enabled, false);
  assert.throws(
    () => selectQaProfile(farm, undefined, { lane: 'source', target: '  ' }),
    /Target is required/,
  );
  assert.throws(
    () => selectQaProfile(farm, undefined, { lane: 'unknown' }),
    /Proof lane has an invalid value/,
  );
  assert.throws(
    () => selectQaProfile(farm, undefined, { lane: 'source', range: { hours: '24' } }),
    /Hours has an invalid value/,
  );
  assert.throws(
    () =>
      validateQaConfig({
        ...farm,
        profiles: [
          {
            ...farm.profiles[0],
            input_fields: [{ path: '__proto__.value', title: 'Bad', type: 'text' }],
          },
        ],
      }),
    /path is invalid/,
  );
});

test('each farm controls its default and explicit selections stay in that farm', () => {
  assert.equal(selectQaProfile(config).profile.id, 'changes');
  assert.equal(selectQaProfile(config, 'candidate').profile.template_id, 'candidate/validation');
  const other: ProjectQaConfig = {
    default_profile: 'quick',
    profiles: [{ id: 'quick', title: 'Quick check', template_id: 'check/default' }],
  };
  assert.equal(selectQaProfile(other).profile.id, 'quick');
  assert.throws(() => selectQaProfile(other, 'candidate'), /does not exist in this farm/);
  assert.throws(() => selectQaProfile(undefined), /no QA presets/);
});

test('explicit inputs replace defaults without interpreting project scope semantics', () => {
  const selected = selectQaProfile(config, undefined, { scope: { kind: 'candidate', ref: 'v2' } });
  assert.deepEqual(selected.inputs, {
    scope: { kind: 'candidate', ref: 'v2' },
    domain: 'payments',
  });
  assert.deepEqual(config.profiles[0].inputs?.scope, { kind: 'window', hours: 24 });
});

test('selected profile and nested inputs are detached from configuration and caller edits', () => {
  const local = JSON.parse(JSON.stringify(config)) as ProjectQaConfig;
  const inputs = { targets: ['one'] };
  const selected = selectQaProfile(local, undefined, inputs);
  local.profiles[0].title = 'Changed';
  local.profiles[0].inputs!.scope = 'changed';
  inputs.targets.push('two');
  assert.equal(selected.profile.title, 'Validate changes');
  assert.deepEqual(selected.inputs.scope, { kind: 'window', hours: 24 });
  assert.deepEqual(selected.inputs.targets, ['one']);
});

test('invalid defaults and duplicate IDs cannot silently select a different workflow', () => {
  assert.throws(
    () => validateQaConfig({ ...config, default_profile: 'missing' }),
    /does not exist/,
  );
  assert.throws(
    () => validateQaConfig({ ...config, profiles: [config.profiles[0], config.profiles[0]] }),
    /Duplicate QA preset/,
  );
  assert.throws(() => selectQaProfile(config, ''), /nonempty/);
});

test('presets reject embedded workflow fields and invalid input values', () => {
  assert.throws(
    () => validateQaConfig({ ...config, profiles: [{ ...config.profiles[0], steps: ['launch'] }] }),
    /steps is not a supported preset field/,
  );
  assert.throws(
    () =>
      validateQaConfig({ ...config, profiles: [{ ...config.profiles[0], inputs: { n: NaN } }] }),
    /JSON values/,
  );
  assert.throws(() => validateQaConfig({ default_profile: 'x', profiles: [] }), /at least one/);
});

test('explicit live review becomes QA with the original settings retained', () => {
  const selected = resolveReviewQaDispatch(
    { flowType: 'review-pr', reviewValidationDepth: 'full-live', reviewTier: 'full' },
    config,
  );
  assert.equal(selected?.flowType, 'qa');
  assert.equal(selected?.qa?.profile.id, 'changes');
  assert.deepEqual(selected?.contract.legacy, { validationDepth: 'full-live', tier: 'full' });
});

test('ambiguous legacy settings require a choice and cannot silently become static', () => {
  for (const input of [
    { reviewTier: 'full' },
    { recipeStrategy: 'smoke' },
    { reviewValidationDepth: 'static-code', reviewTier: 'standard' },
    { reviewValidationDepth: 'static-code', recipeStrategy: 'full-qa' },
  ]) {
    assert.throws(
      () => resolveReviewQaDispatch({ flowType: 'review-pr', ...input }, config),
      /ambiguous/,
    );
  }
  assert.throws(
    () => resolveReviewQaDispatch({ flowType: 'qa', reviewValidationDepth: 'static-code' }, config),
    /conflicts/,
  );
  assert.throws(
    () => resolveReviewQaDispatch({ flowType: 'review-pr', reviewValidationDepth: 'full-live' }),
    /Configure this farm/,
  );
});

test('modern static Review has no implicit QA and unrelated flows cannot smuggle QA inputs', () => {
  assert.deepEqual(resolveReviewQaDispatch({ flowType: 'review-pr' }), {
    flowType: 'review-pr',
    contract: { version: 1 },
  });
  assert.equal(resolveReviewQaDispatch({ flowType: 'dev' }), undefined);
  assert.throws(
    () => resolveReviewQaDispatch({ flowType: 'review-pr', qaProfileId: 'changes' }, config),
    /Static Review cannot/,
  );
  assert.throws(
    () => resolveReviewQaDispatch({ flowType: 'dev', qaInputs: {} }, config),
    /require the QA flow/,
  );
});

test('review intake accepts modern workflows and distinguishes QA profile/input purposes', () => {
  const review = {
    sessionIntent: 'resume' as const,
    scope: 'incremental' as const,
    workflow: 'review' as const,
  };
  const qa = {
    ...review,
    workflow: 'qa' as const,
    qaProfileId: 'change-proof',
    qaInputs: { a: 1, b: { c: true } },
  };
  assert.doesNotThrow(() => assertPRReviewOptions(review));
  assert.doesNotThrow(() => assertPRReviewOptions(qa));
  assert.notEqual(prReviewPurpose(review), prReviewPurpose(qa));
  assert.notEqual(prReviewPurpose(qa), prReviewPurpose({ ...qa, qaProfileId: 'another' }));
  assert.equal(prReviewPurpose(qa), prReviewPurpose({ ...qa, qaInputs: { b: { c: true }, a: 1 } }));
  assert.equal(
    samePRReviewOptions(review, {
      sessionIntent: 'resume',
      scope: 'incremental',
      validationDepth: 'static-code',
    }),
    true,
  );
  assert.throws(
    () => assertPRReviewOptions({ ...review, qaProfileId: 'change-proof' }),
    /require the QA workflow/,
  );
  assert.throws(
    () => assertPRReviewOptions({ ...qa, validationDepth: 'static-code' }),
    /conflicts/,
  );
});

test('new independent review loops must be static and name the QA flow for runtime validation', () => {
  assert.doesNotThrow(() => assertStaticReviewLoopRequests(undefined));
  assert.doesNotThrow(() =>
    assertStaticReviewLoopRequests([{ runner: 'codex', validationDepth: 'static-code' }, {}]),
  );
  assert.throws(
    () =>
      assertStaticReviewLoopRequests(
        [{ validationDepth: 'static-code' }, { validationDepth: 'full-live' }],
        'reviewRequest.loops',
      ),
    (error: Error & { code?: string }) =>
      error.code === 'REVIEW_QA_NEEDS_CONFIGURATION' &&
      /^reviewRequest\.loops\[1\] requests full-live validation/.test(error.message) &&
      /QA flow/.test(error.message),
  );
});
