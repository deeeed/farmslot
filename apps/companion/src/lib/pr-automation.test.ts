import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PRExecutionProfile,
  PRMonitor,
  PRProjectMonitorPolicy,
  PRReviewIntent,
  PRTeamProfile,
  Run,
} from '@farmslot/protocol';
import {
  ReviewDispatchViewModel,
  reviewLineagesForPR,
  reviewSequenceForExecution,
} from '@farmslot/review-dispatch';

import {
  buildPRMonitorConfig,
  buildPRRequest,
  effectivePRRequest,
  newPRExecution,
  newPRMonitorDraft,
  newPRRequestDraft,
  prExecutionText,
  prReviewText,
  qaRequestFromReview,
  togglePRSlot,
  updatePRReviewOptions,
} from './pr-automation';

const execution = { ...newPRExecution(), slotPolicy: { kind: 'exact' as const, slotId: 'slot-a' } };
const team: PRTeamProfile = {
  id: 'team',
  ownerId: 'owner',
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  config: {
    name: 'Team',
    account: { host: 'github.com', login: 'reader' },
    sources: [{ kind: 'repository', repo: 'owner/repo' }],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
    execution,
    review: { mode: 'warm' },
    repositories: [
      {
        repo: 'owner/repo',
        project: 'project',
        reviewProfile: 'security',
        excludedLabels: [],
        review: { mode: 'cold' },
      },
    ],
    githubTeams: [],
    notificationPrincipalIds: [],
  },
};

test('requests inherit repository review options and team execution without serializing silent overrides', () => {
  const draft = {
    ...newPRRequestDraft(),
    url: 'https://github.com/OWNER/REPO/pull/42',
    teamId: team.id,
  };
  const effective = effectivePRRequest(draft, [team]);
  assert.equal(effective.project, 'project');
  assert.equal(effective.review.mode, 'cold');
  assert.equal(effective.review.workflow, 'review');
  assert.deepEqual(effective.execution, execution);
  const request = buildPRRequest(draft, 'stable-request');
  assert.equal(request.review, undefined);
  assert.equal(request.execution, undefined);
  assert.equal(request.autoStart, false);
  assert.equal(request.source.client, 'companion');
  assert.deepEqual(Object.keys(request.pr).sort(), ['host', 'number', 'repo']);
});

test('explicit review/QA overrides preserve the selected policy and idempotency key', () => {
  const draft = {
    ...newPRRequestDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    teamId: team.id,
    overrideReview: true,
    overrideExecution: true,
    execution,
    review: {
      mode: 'warm' as const,
    },
  };
  assert.deepEqual(
    buildPRRequest(draft, 'stable-request'),
    buildPRRequest(draft, 'stable-request'),
  );
  assert.equal(buildPRRequest(draft, 'stable-request').review?.mode, 'warm');
  assert.throws(
    () => buildPRRequest({ ...draft, url: 'https://github.com/owner/repo/issues/42' }, 'key'),
    /pull request URL/,
  );
});

test('editing monitoring preserves principal-bound PR/account/team identity and allows explicit policy changes', () => {
  const config = buildPRMonitorConfig({
    ...newPRMonitorDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    login: 'reader',
  });
  const monitor: PRMonitor = {
    id: 'monitor',
    revision: 3,
    ownerId: 'owner',
    lifecycle: 'active',
    config: { ...config, teamId: 'team' },
    incidents: [],
    originatingRunIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const draft = {
    ...newPRMonitorDraft(monitor),
    url: 'https://github.com/another/repo/pull/1',
    login: 'different-reader',
    automatic: true,
    execution,
    project: 'project',
  };
  const edited = buildPRMonitorConfig(draft, monitor);
  assert.deepEqual(edited.pr, monitor.config.pr);
  assert.deepEqual(edited.account, monitor.config.account);
  assert.equal(edited.teamId, 'team');
  assert.equal(edited.policy.mode, 'automatic-repair');
  assert.throws(() => buildPRMonitorConfig({ ...draft, project: '' }, monitor), /project/);
  assert.throws(
    () => buildPRMonitorConfig({ ...draft, intervalSeconds: '0' }, monitor),
    /pollInterval/,
  );
});

test('slot selection remains bounded when switching between an exact slot and pool', () => {
  const two = togglePRSlot(execution, 'slot-b');
  assert.deepEqual(two.slotPolicy, { kind: 'pool', allowedSlots: ['slot-a', 'slot-b'] });
  assert.deepEqual(togglePRSlot(two, 'slot-a').slotPolicy, { kind: 'exact', slotId: 'slot-b' });
  assert.deepEqual(togglePRSlot(execution, 'slot-a').slotPolicy, {
    kind: 'pool',
    allowedSlots: [],
  });
  assert.deepEqual(two.models, execution.models);
});

test('publication policy edits preserve enterprise hosts and check names containing commas', () => {
  const policy: PRProjectMonitorPolicy = {
    project: 'project',
    ownerId: 'owner',
    revision: 1,
    enabled: false,
    activatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      account: { host: 'git.example.com', login: 'reader' },
      policy: { mode: 'notify-only' },
      watchedChecks: ['test (ubuntu-latest, node-20)', 'lint'],
      pollIntervalMs: 300_000,
      automaticAttemptLimit: 2,
      cooldownMs: 600_000,
    },
  };
  const draft = newPRMonitorDraft(undefined, policy);
  const result = buildPRMonitorConfig({ ...draft, intervalSeconds: '600' }, undefined, true);
  assert.deepEqual(result.account, policy.config.account);
  assert.deepEqual(result.watchedChecks, policy.config.watchedChecks);
  assert.equal(result.pollIntervalMs, 600_000);
});

test('QA transition removes static publication and uses its separate cold workflow', () => {
  const qa = updatePRReviewOptions(
    {
      mode: 'warm',
      reviewContext: {
        reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: 'review-42' }],
      },
      publishReview: true,
    },
    { workflow: 'qa', qaProfileId: 'daily', qaInputs: { hours: 24 } },
  );
  assert.equal(qa.publishReview, undefined);
  assert.equal(qa.mode, 'cold');
  assert.equal(qa.reviewContext, undefined);
  const review = updatePRReviewOptions(qa, { workflow: 'review' });
  assert.equal(review.qaProfileId, undefined);
  assert.equal(review.qaInputs, undefined);
});

test('static publication inherits independently and explicit opt-out wins', () => {
  const selectedTeam = structuredClone(team);
  selectedTeam.config.review = {
    workflow: 'review',
    mode: 'cold',
    publishReview: true,
  };
  selectedTeam.config.repositories[0].review = {
    workflow: 'review',
    mode: 'cold',
  };
  const draft = {
    ...newPRRequestDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    teamId: team.id,
  };
  assert.equal(effectivePRRequest(draft, [selectedTeam]).review.publishReview, true);
  assert.equal(effectivePRRequest(draft, [selectedTeam]).sources.publication, 'team');
  const override = {
    ...draft,
    overrideReview: true,
    review: updatePRReviewOptions(draft.review, { publishReview: false }),
  };
  assert.equal(effectivePRRequest(override, [selectedTeam]).review.publishReview, false);
  assert.equal(effectivePRRequest(override, [selectedTeam]).sources.publication, 'request');
  const qa = { ...override, review: updatePRReviewOptions(override.review, { workflow: 'qa' }) };
  assert.equal(effectivePRRequest(qa, [selectedTeam]).review.publishReview, undefined);
});

test('QA request serializes JSON object inputs and rejects other roots', () => {
  const draft = {
    ...newPRRequestDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    teamId: team.id,
    overrideReview: true,
    review: updatePRReviewOptions(newPRRequestDraft().review, {
      workflow: 'qa',
      qaProfileId: 'daily',
    }),
    qaInputsText: '{"hours":24,"recipes":["smoke"]}',
  };
  assert.deepEqual(buildPRRequest(draft, 'qa-inputs').review?.qaInputs, {
    hours: 24,
    recipes: ['smoke'],
  });
  for (const qaInputsText of ['[]', 'null', '42', '"text"']) {
    assert.throws(() => buildPRRequest({ ...draft, qaInputsText }, 'qa-inputs'), /JSON object/);
  }
  assert.throws(() => buildPRRequest({ ...draft, qaInputsText: '{' }, 'qa-inputs'), SyntaxError);
});

test('Run QA links only an owned completed review at the selected head', () => {
  const headSha = 'a'.repeat(40);
  const intent = {
    runId: 'review',
    status: 'completed',
    headSha,
    pr: { host: 'github.com', repo: 'owner/repo', number: 42 },
    contributions: [
      { ownerId: 'owner', teamId: team.id, project: 'project', review: { workflow: 'review' } },
    ],
  } as PRReviewIntent;
  const run = {
    id: 'review',
    project: 'project',
    ticketOrPr: 'owner/repo#42',
    createdByPrincipalId: 'owner',
    flowType: 'review-pr',
    status: 'done',
    decisions: [],
    reviewResult: { reviewMd: 'Review complete', reviewSnapshot: { headSha, source: 'github-pr' } },
  } as unknown as Run;
  const draft = qaRequestFromReview(intent, run, 'owner');
  assert.equal(draft.teamId, team.id);
  assert.equal(draft.review.workflow, 'qa');
  assert.equal(draft.autoStart, false);
  assert.equal(buildPRRequest(draft, 'linked').sourceReviewRunId, run.id);
  assert.equal(
    buildPRRequest({ ...draft, url: 'https://github.com/owner/repo/pull/43' }, 'other')
      .sourceReviewRunId,
    undefined,
  );
  assert.equal(
    buildPRRequest(
      { ...draft, review: updatePRReviewOptions(draft.review, { workflow: 'review' }) },
      'static',
    ).sourceReviewRunId,
    undefined,
  );
  for (const [candidate, owner] of [
    [undefined, 'owner'],
    [run, 'other'],
    [{ ...run, status: 'monitoring' }, 'owner'],
    [{ ...run, nativeOwnerPrincipalId: 'other' }, 'owner'],
    [{ ...run, project: 'other' }, 'owner'],
    [{ ...run, ticketOrPr: 'other/repo#42' }, 'owner'],
    [{ ...run, reviewValidationDepth: 'full-live' }, 'owner'],
    [
      {
        ...run,
        reviewResult: { ...run.reviewResult, reviewSnapshot: { headSha: 'b'.repeat(40) } },
      },
      'owner',
    ],
  ] as Array<[Run | undefined, string]>) {
    assert.equal(qaRequestFromReview(intent, candidate, owner).sourceReview, undefined);
  }
});

test('QA profiles and merged inputs come from the mapped farm', () => {
  const draft = {
    ...newPRRequestDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    teamId: team.id,
    overrideReview: true,
    review: updatePRReviewOptions(newPRRequestDraft().review, {
      workflow: 'qa',
      qaInputs: { hours: 12 },
    }),
  };
  const farms = [
    {
      name: 'project',
      qa: {
        default_profile: 'daily',
        profiles: [
          {
            id: 'daily',
            title: 'Daily',
            template_id: 'shared-qa',
            inputs: { hours: 24, domain: 'assets' },
          },
        ],
      },
    },
  ];
  const effective = effectivePRRequest(draft, [team], farms);
  assert.equal(effective.qa?.default_profile, 'daily');
  assert.deepEqual(effective.qaInputs, { hours: 12, domain: 'assets' });
  assert.deepEqual(effectivePRRequest(draft, [team], []).qaInputs, { hours: 12 });
});

test('portable pool execution remains readable before registry binding', () => {
  const profile = {
    workspacePolicy: { kind: 'pool' as const },
    transport: 'native' as const,
    models: execution.models,
  };
  assert.match(prExecutionText(profile), /Review machines: Configured pool/);
  assert.deepEqual(profile.models, execution.models);
  assert.equal(profile.workspacePolicy.kind, 'pool');
});

test('request serialization preserves each review selection and its slot restrictions', () => {
  const models = [
    {
      runner: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      mode: 'cold' as const,
      allowedSlots: ['slot-a'],
    },
    {
      runner: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      mode: 'warm' as const,
      allowedSlots: ['slot-b'],
    },
  ];
  const draft = {
    ...newPRRequestDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    teamId: team.id,
    overrideReview: true,
    overrideExecution: true,
    execution: {
      slotPolicy: { kind: 'pool' as const, allowedSlots: ['slot-a', 'slot-b'] },
      models,
    },
    review: { workflow: 'review' as const, mode: 'cold' as const },
  };
  const request = buildPRRequest(draft, 'selected-rows');
  assert.deepEqual(request.execution?.models, models);
  assert.equal(request.review?.mode, 'cold');
  assert.match(prExecutionText(request.execution), /gpt-6.1-sol\/high/);
  assert.match(prReviewText({ mode: 'warm' }), /WARM review/);
});

test('request validation refuses unsupported effort through the shared picker validator', () => {
  const draft = {
    ...newPRRequestDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    teamId: team.id,
    overrideExecution: true,
    execution: {
      ...execution,
      models: [{ runner: 'claude', model: 'opus', effort: 'high', mode: 'cold' as const }],
    },
  };
  assert.throws(() => buildPRRequest(draft, 'unsupported-effort'), /Unsupported review effort/);
});

test('PR requests preserve shared WARM lineage context independently of runner choice', () => {
  const retained = {
    mode: 'cold' as const,
    continuity: 'fresh' as const,
    reviewId: 'review-42',
    repository: 'owner/repo',
    prNumber: 42,
    sessionId: 'retained-review-session',
    lastReviewedHeadSha: 'a'.repeat(40),
    runner: 'claude',
  };
  const run = { decisions: [], reviewResult: { session: retained } } as unknown as Run;
  const lineages = reviewLineagesForPR([run], {
    host: 'github.com',
    repo: 'owner/repo',
    number: 42,
  });
  const picker = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      sequenceRole: 'execution-alternatives',
      reviewLineages: lineages,
    },
  });
  picker.setRunner(picker.rows[0].id, 'codex');
  picker.setMode(picker.rows[0].id, 'warm');
  const reviewContext = picker.toReviewContext();
  const request = buildPRRequest(
    {
      ...newPRRequestDraft(),
      url: 'https://github.com/owner/repo/pull/42',
      teamId: team.id,
      overrideReview: true,
      overrideExecution: true,
      review: { mode: 'warm', reviewContext },
      execution: { ...execution, models: picker.toExecutionModels() },
    },
    'warm-lineage',
  );
  assert.equal(request.execution?.models[0].runner, 'codex');
  assert.deepEqual(request.review?.reviewContext, {
    reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: 'review-42' }],
  });
});

test('missing or ambiguous WARM provenance blocks the shared picker without changing mode', () => {
  const retained = {
    mode: 'cold' as const,
    continuity: 'fresh' as const,
    repository: 'owner/repo',
    prNumber: 42,
    sessionId: 'retained-review-session',
    lastReviewedHeadSha: 'a'.repeat(40),
  };
  const runs = ['review-a', 'review-b'].map(
    (reviewId) =>
      ({
        decisions: [],
        reviewResult: { session: { ...retained, reviewId } },
      }) as unknown as Run,
  );
  for (const candidates of [[], runs]) {
    const picker = new ReviewDispatchViewModel({
      context: {
        allowedActions: ['configure'],
        sequenceRole: 'execution-alternatives',
        reviewLineages: reviewLineagesForPR(candidates, {
          host: 'github.com',
          repo: 'owner/repo',
          number: 42,
        }),
      },
    });
    picker.setMode(picker.rows[0].id, 'warm');
    assert.equal(picker.canInvoke('configure'), false);
    assert.equal(picker.rows[0].selection.mode, 'warm');
    assert.throws(() => picker.toExecutionModels(), /unambiguous.*reviewId lineage/);
  }
});

test('the QA picker keeps its work separate from unavailable static WARM provenance', () => {
  const picker = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      sequenceRole: 'execution-alternatives',
      workflow: 'qa',
    },
    sequence: [{ runner: 'codex', model: null, effort: null, mode: 'warm' }],
  });
  assert.equal(picker.canInvoke('configure'), true);
  assert.equal(picker.toReviewContext(), undefined);
  const qa = updatePRReviewOptions({ mode: 'warm' }, { workflow: 'qa' });
  assert.equal(qa.mode, 'cold');
  assert.equal(qa.reviewContext, undefined);
});

test('six and twenty PR alternatives retain null defaults and row resources through editing and serialization', () => {
  for (const count of [6, 20]) {
    const models = Array.from({ length: count }, (_, index) => ({
      runner: 'codex',
      model: index % 2 ? 'gpt-6-sol' : null,
      effort: index % 2 ? 'medium' : null,
      mode: 'cold' as const,
      allowedSlots: [`slot-${index}`],
    }));
    const profile: PRExecutionProfile = {
      slotPolicy: { kind: 'pool', allowedSlots: models.flatMap((model) => model.allowedSlots) },
      models,
    };
    const picker = new ReviewDispatchViewModel({
      context: {
        allowedActions: ['configure'],
        allowSequence: true,
        sequenceRole: 'execution-alternatives',
      },
      sequence: reviewSequenceForExecution(profile.models),
    });
    const resources = new Map(
      picker.rows.map((row, index) => [row.id, { allowedSlots: models[index].allowedSlots }]),
    );
    picker.moveRow(picker.rows.at(-1)!.id, 0);
    const expected = [models.at(-1)!, ...models.slice(0, -1)];
    const selected = { ...profile, models: picker.toExecutionModels(resources) };
    const request = buildPRRequest(
      {
        ...newPRRequestDraft(),
        url: 'https://github.com/owner/repo/pull/42',
        teamId: team.id,
        overrideExecution: true,
        execution: selected,
      },
      `alternatives-${count}`,
    );
    assert.deepEqual(request.execution?.models, expected);
    const monitor = buildPRMonitorConfig({
      ...newPRMonitorDraft(),
      url: 'https://github.com/owner/repo/pull/42',
      login: 'reader',
      project: 'project',
      automatic: true,
      execution: selected,
    });
    assert.equal(monitor.policy.mode, 'automatic-repair');
    if (monitor.policy.mode === 'automatic-repair')
      assert.deepEqual(monitor.policy.execution.models, expected);
    if (count === 20) assert.equal(picker.canAddRow, false);
  }
});

test('the PR alternative limit remains twenty while counted review sequences remain five', () => {
  const selection = { runner: 'codex', model: null, effort: null, mode: 'cold' as const };
  assert.throws(
    () =>
      new ReviewDispatchViewModel({
        context: {
          allowedActions: ['configure'],
          allowSequence: true,
          sequenceRole: 'execution-alternatives',
        },
        sequence: Array.from({ length: 21 }, () => ({ ...selection })),
      }),
    /20/,
  );
  assert.throws(
    () =>
      new ReviewDispatchViewModel({
        context: { allowedActions: ['request-review'], allowSequence: true },
        sequence: Array.from({ length: 6 }, () => ({ ...selection })),
      }),
    /5/,
  );
});

test('QA requests carry the visible sole or configured profile without implicit input overrides', () => {
  const draft: ReturnType<typeof newPRRequestDraft> = {
    ...newPRRequestDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    teamId: team.id,
    overrideReview: true,
    review: { mode: 'cold', workflow: 'qa' },
  };
  const farms: NonNullable<Parameters<typeof effectivePRRequest>[2]> = [
    {
      name: 'project',
      qa: {
        profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/shared', inputs: { count: 1 } }],
      },
    },
  ];
  let effective = effectivePRRequest(draft, [team], farms);
  assert.equal(effective.review.qaProfileId, 'smoke');
  let request = buildPRRequest(draft, 'single', effective);
  assert.equal(request.review?.qaProfileId, 'smoke');
  assert.equal(request.review?.qaInputs, undefined);
  farms[0].qa!.profiles.push({ id: 'full', title: 'Full', template_id: 'qa/shared' });
  effective = effectivePRRequest(draft, [team], farms);
  assert.equal(effective.review.qaProfileId, undefined);
  assert.throws(() => buildPRRequest(draft, 'multiple', effective), /Choose a QA profile/);
  farms[0].qa!.default_profile = 'full';
  effective = effectivePRRequest(draft, [team], farms);
  assert.equal(effective.review.qaProfileId, 'full');
  request = buildPRRequest(draft, 'configured-default', effective);
  assert.equal(request.review?.qaProfileId, 'full');
});

test('QA profile policy beats the configured default while an explicit user pick wins', () => {
  const draft: ReturnType<typeof newPRRequestDraft> = {
    ...newPRRequestDraft(),
    url: 'https://github.com/owner/repo/pull/42',
    teamId: team.id,
    overrideReview: true,
    review: { mode: 'cold', workflow: 'qa' },
  };
  const farms: NonNullable<Parameters<typeof effectivePRRequest>[2]> = [
    {
      name: 'project',
      qa: {
        default_profile: 'full',
        profiles: [
          { id: 'smoke', title: 'Smoke', template_id: 'qa/shared' },
          { id: 'full', title: 'Full', template_id: 'qa/shared' },
        ],
      },
      workflowDefaults: { qa: { review: { mode: 'cold', workflow: 'qa', qaProfileId: 'smoke' } } },
    },
  ];
  let effective = effectivePRRequest(draft, [team], farms);
  assert.equal(effective.review.qaProfileId, 'smoke');
  assert.equal(buildPRRequest(draft, 'policy', effective).review?.qaProfileId, 'smoke');
  draft.review.qaProfileId = 'full';
  effective = effectivePRRequest(draft, [team], farms);
  assert.equal(effective.review.qaProfileId, 'full');
  assert.equal(buildPRRequest(draft, 'explicit', effective).review?.qaProfileId, 'full');
});
