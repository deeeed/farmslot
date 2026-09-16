import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectWorkflowDefaults, PRWorkflowPolicy } from '../../src/contracts/config.js';
import type {
  PRSlotExecutionProfile,
  PRWorkspaceExecutionProfile,
} from '../../src/contracts/pr-monitoring.js';
import { samePRReviewOptions } from '../../src/contracts/pr-rules.js';
import {
  normalizeProjectWorkflowDefaults,
  resolvePRWorkflowDefaults,
} from '../../src/integrations/pr-workflow-defaults.js';

const reviewExecution: PRWorkspaceExecutionProfile = {
  workspacePolicy: { kind: 'pool', allowedMachines: ['one', 'two'] },
  transport: 'native',
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high', allowedMachines: ['two'] }],
};
const qaExecution: PRSlotExecutionProfile = {
  slotPolicy: { kind: 'exact', slotId: 'runtime' },
  models: [{ runner: 'runner', model: 'model' }],
};
const farm: ProjectWorkflowDefaults = {
  'review-pr': { execution: reviewExecution, review: { sessionIntent: 'reset', scope: 'full' } },
  qa: {
    execution: qaExecution,
    review: { sessionIntent: 'resume', scope: 'full', workflow: 'qa', qaProfileId: 'daily' },
  },
};

test('farm defaults resolve independently for Review and QA and retain source information', () => {
  const review = resolvePRWorkflowDefaults({ farm });
  assert.equal(review.workflow, 'review-pr');
  assert.deepEqual(review.execution, reviewExecution);
  assert.deepEqual(review.review, { sessionIntent: 'reset', scope: 'full', workflow: 'review' });
  assert.deepEqual(review.sources, { execution: 'farm', review: 'farm', publication: 'built-in' });
  const qa = resolvePRWorkflowDefaults({ workflow: 'qa', farm });
  assert.deepEqual(qa.execution, qaExecution);
  assert.equal(qa.review.qaProfileId, 'daily');
  assert.equal(qa.review.workflow, 'qa');
  const builtIn = resolvePRWorkflowDefaults({ workflow: 'qa' });
  assert.equal(builtIn.execution, undefined);
  assert.equal(builtIn.review.workflow, 'qa');
  assert.deepEqual(builtIn.sources, {
    execution: null,
    review: 'built-in',
    publication: 'built-in',
  });
});

test('request, rule, repository and team precedence selects complete policies without broadening them', () => {
  const layers = ['request', 'rule', 'repository', 'team'] as const;
  const configured: Partial<Record<(typeof layers)[number], PRWorkflowPolicy>> = {};
  for (const layer of [...layers].reverse()) {
    const execution: PRWorkspaceExecutionProfile = {
      workspacePolicy: { kind: 'exact', machine: layer },
      models: [{ runner: layer, model: `${layer}-model` }],
      transport: 'native',
    };
    configured[layer] = {
      execution,
      review: { sessionIntent: 'resume', scope: 'incremental', busySession: 'fresh' },
    };
    const result = resolvePRWorkflowDefaults({ ...configured, farm });
    assert.deepEqual(result.execution, execution);
    assert.deepEqual(result.sources, { execution: layer, review: layer, publication: 'built-in' });
  }
  const explicitLegacy = resolvePRWorkflowDefaults({ request: { execution: qaExecution }, farm });
  assert.deepEqual(
    explicitLegacy.execution,
    qaExecution,
    'Legacy slot pins are preserved for migration, never replaced by farm machines',
  );
  assert.deepEqual(explicitLegacy.sources, {
    execution: 'request',
    review: 'farm',
    publication: 'built-in',
  });
});

test('explicit workflow chooses the farm map before execution selection and rejects contradictory options', () => {
  const qa = resolvePRWorkflowDefaults({
    request: { review: { sessionIntent: 'reset', scope: 'full', workflow: 'qa' } },
    farm,
  });
  assert.equal(qa.workflow, 'qa');
  assert.deepEqual(qa.execution, qaExecution);
  const legacyQa = resolvePRWorkflowDefaults({
    rule: { review: { sessionIntent: 'reset', scope: 'full', validationDepth: 'full-live' } },
    farm,
  });
  assert.equal(legacyQa.workflow, 'qa');
  assert.equal(legacyQa.review.validationDepth, 'full-live');
  assert.throws(
    () =>
      resolvePRWorkflowDefaults({
        workflow: 'review-pr',
        request: { review: { sessionIntent: 'resume', scope: 'full', workflow: 'qa' } },
        farm,
      }),
    /conflicts/,
  );
});

test('normalization rejects invalid authority and prevents mutation of the configured defaults', () => {
  assert.equal(normalizeProjectWorkflowDefaults(undefined), undefined);
  for (const invalid of [
    null,
    [],
    { release: {} },
    { qa: {} },
    { qa: { script: 'run' } },
    { 'review-pr': { execution: qaExecution } },
    { qa: { execution: reviewExecution } },
    { 'review-pr': { review: { sessionIntent: 'resume', scope: 'full', workflow: 'qa' } } },
    { qa: { review: { sessionIntent: 'resume', scope: 'full', validationDepth: 'static-code' } } },
    {
      'review-pr': {
        execution: {
          ...reviewExecution,
          models: [{ runner: 'codex', model: 'gpt-6-astra', allowedMachines: ['unlisted'] }],
        },
      },
    },
  ])
    assert.throws(() => normalizeProjectWorkflowDefaults(invalid));
  const normalized = normalizeProjectWorkflowDefaults(farm)!;
  normalized['review-pr']!.review!.scope = 'incremental';
  assert.equal(farm['review-pr']!.review!.scope, 'full');
  const selected = resolvePRWorkflowDefaults({ farm });
  selected.execution!.models[0].runner = 'changed';
  assert.equal(farm['review-pr']!.execution!.models[0].runner, 'codex');
});

test('static farm review options from the first delivery remain valid after QA migration', () => {
  const legacy = {
    'review-pr': {
      execution: reviewExecution,
      review: {
        sessionIntent: 'resume' as const,
        scope: 'incremental' as const,
        validationDepth: 'static-code' as const,
      },
    },
  };
  const resolved = resolvePRWorkflowDefaults({ farm: legacy });
  assert.equal(resolved.workflow, 'review-pr');
  assert.deepEqual(resolved.execution, reviewExecution);
  assert.equal(resolved.review.validationDepth, 'static-code');
});

test('publication inherits project opt-in independently from ordinary review options', () => {
  const optedIn = {
    ...farm,
    'review-pr': {
      ...farm['review-pr'],
      review: { sessionIntent: 'reset' as const, scope: 'full' as const, publishReview: true },
    },
  };
  const request = { review: { sessionIntent: 'resume' as const, scope: 'incremental' as const } };
  const inherited = resolvePRWorkflowDefaults({ farm: optedIn, request });
  assert.equal(inherited.review.publishReview, true);
  assert.equal(inherited.sources.publication, 'farm');
  assert.equal(inherited.sources.review, 'request');
  const disabled = resolvePRWorkflowDefaults({
    farm: optedIn,
    request: { review: { ...request.review, publishReview: false } },
  });
  assert.equal(disabled.review.publishReview, false);
  assert.equal(disabled.sources.publication, 'request');
  const plain = resolvePRWorkflowDefaults({ request });
  assert.notEqual(plain.review.publishReview, true);
  assert.equal(plain.sources.publication, 'built-in');
});

test('publication follows request, rule, repository, team and farm precedence', () => {
  const review = { sessionIntent: 'reset' as const, scope: 'full' as const };
  const layers = ['team', 'repository', 'rule', 'request'] as const;
  const configured: Partial<Record<(typeof layers)[number], PRWorkflowPolicy>> = {};
  for (const [index, layer] of layers.entries()) {
    configured[layer] = { review: { ...review, publishReview: index % 2 === 0 } };
    const result = resolvePRWorkflowDefaults({ ...configured, farm });
    assert.equal(result.review.publishReview, index % 2 === 0);
    assert.equal(result.sources.publication, layer);
  }
  assert.throws(
    () => normalizeProjectWorkflowDefaults({ qa: { review: { ...review, publishReview: true } } }),
    /QA cannot publish/,
  );
  assert.throws(
    () =>
      resolvePRWorkflowDefaults({
        workflow: 'qa',
        request: { review: { ...review, publishReview: true } },
      }),
    /QA cannot publish/,
  );
  assert.throws(
    () =>
      resolvePRWorkflowDefaults({ team: { review: { ...review, publishReview: 'yes' } } as never }),
    /boolean/,
  );
});

test('sharing a running review requires the same effective publication choice', () => {
  const review = { sessionIntent: 'reset' as const, scope: 'full' as const };
  assert.equal(samePRReviewOptions(review, { ...review, publishReview: false }), true);
  assert.equal(
    samePRReviewOptions({ ...review, publishReview: true }, { ...review, publishReview: false }),
    false,
  );
});

test('QA requests do not inherit static publication from lower-priority team policy', () => {
  const resolved = resolvePRWorkflowDefaults({
    request: { review: { sessionIntent: 'reset', scope: 'full', workflow: 'qa' } },
    team: { review: { sessionIntent: 'reset', scope: 'full', publishReview: true } },
  });
  assert.equal(resolved.workflow, 'qa');
  assert.equal(resolved.review.publishReview, undefined);
  assert.equal(resolved.sources.publication, 'built-in');
});

test('publication gate defaults inherit independently and explicit hold wins', () => {
  const configured = {
    'review-pr': {
      review: { sessionIntent: 'reset' as const, scope: 'full' as const, autoFinish: true },
    },
  };
  const request = { review: { sessionIntent: 'reset' as const, scope: 'incremental' as const } };
  assert.equal(resolvePRWorkflowDefaults({ farm: configured, request }).review.autoFinish, true);
  assert.equal(
    resolvePRWorkflowDefaults({
      farm: configured,
      request: { review: { ...request.review, autoFinish: false } },
    }).review.autoFinish,
    false,
  );
  assert.equal(resolvePRWorkflowDefaults({}).review.autoFinish, undefined);
});
