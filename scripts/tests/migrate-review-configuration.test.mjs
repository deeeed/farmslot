import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { tsImport } from 'tsx/esm/api';

import {
  convertReviewConfiguration,
  migrateReviewConfiguration,
} from '../migrate-review-configuration.mjs';

const { parseRunRecordFile } = await tsImport(
  '../../packages/run-bundle/src/collect.ts',
  import.meta.url,
);
const script = fileURLToPath(new URL('../migrate-review-configuration.mjs', import.meta.url));
const policy = {
  minimumIndependentReviews: 1,
  requireCrossRunner: false,
  extraLoopsRequested: 1,
  countingVersion: 2,
  requestedBy: 'dispatch',
};
const row = {
  order: 1,
  runner: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
  validationDepth: 'static-code',
  sessionIntent: 'resume',
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-conversion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    root,
    backlog: path.join(root, '.backlog.json'),
    queue: path.join(root, '.dispatch-queue.json'),
    runs: path.join(root, '.runs'),
    projects: path.join(root, 'projects'),
    apply: false,
  };
  await mkdir(options.runs);
  await mkdir(path.join(options.projects, 'example'), { recursive: true });
  return options;
}

const write = (file, value) => writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('legacy ordered selections become explicit COLD rows without WARM lineage', () => {
  const result = convertReviewConfiguration(
    {
      id: 'item-1',
      reviewDepth: policy,
      pendingReviewPlan: [row, { ...row, order: 2, runner: 'claude', model: 'opus', effort: null }],
    },
    'backlog',
  );
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.value.reviewPolicy, { minimumReviews: 2, requestedBy: 'dispatch' });
  assert.deepEqual(result.value.reviewSequence, [
    { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'cold' },
    { runner: 'claude', model: 'opus', effort: null, mode: 'cold' },
  ]);
  assert(!('reviewSequenceContext' in result.value));
  assert(!('reviewDepth' in result.value));
  assert.equal(result.value.id, 'item-1');
  const v1 = { ...policy, extraLoopsRequested: 2, countingVersion: undefined };
  assert.equal(
    convertReviewConfiguration(
      { reviewDepth: v1, pendingReviewPlan: [row, { ...row, order: 2 }] },
      'backlog',
    ).value.reviewPolicy.minimumReviews,
    2,
  );
  assert.equal(
    convertReviewConfiguration(
      {
        reviewDepth: { ...v1, countingVersion: 2 },
        pendingReviewPlan: [row, { ...row, order: 2 }],
      },
      'backlog',
    ).value.reviewPolicy.minimumReviews,
    3,
  );
  assert.equal(
    convertReviewConfiguration(
      {
        reviewDepth: v1,
        independentReviews: [
          { id: 'review-1', source: 'dispatch' },
          { id: 'review-2', source: 'dispatch' },
        ],
      },
      'run',
    ).value.reviewPolicy.minimumReviews,
    2,
  );
});

test('historical run IDs, verdicts, session/range evidence and artifacts survive vocabulary conversion', () => {
  const snapshot = {
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diffPath: 'artifacts/SELF-REVIEW.diff',
    diffHash: 'unchanged-hash',
  };
  const session = {
    intent: 'resume',
    continuity: 'resumed',
    priorRunId: 'old-run',
    priorSessionId: 'old-session',
    sessionId: 'old-session',
  };
  const review = {
    id: 'independent-review-1',
    source: 'self-review',
    crossRunner: false,
    reviewerSessionId: 'old-session',
    verdict: 'pass',
    reviewSnapshot: snapshot,
    artifactPaths: ['artifacts/SELF-REVIEW.md'],
  };
  const original = {
    id: 'run-1',
    status: 'self-reviewing',
    agentContexts: [
      {
        id: 'self-review',
        role: 'self-review',
        runnerSessionId: 'old-session',
        runnerSessionPath: '/fixture/session.json',
        taskFile: 'task/SELF-REVIEW.md',
      },
      { id: 'self-review-fix', role: 'self-review-fix' },
    ],
    steps: [{ name: 'self-review', outputs: { independentReviews: [review] } }],
    repeatReviewContext: {
      reviewScope: 'incremental',
      contextMode: 'reuse',
      sessionIntent: 'resume',
      session,
      artifactRefs: [{ path: 'artifacts/SELF-REVIEW.md', sha256: 'unchanged-hash' }],
      priorReviewedHeadSha: snapshot.baseSha,
      currentHeadSha: snapshot.headSha,
    },
    qa: { inputs: { scope: 'all' } },
  };
  const result = convertReviewConfiguration(original, 'run');
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.value.status, 'reviewing');
  assert.equal(result.value.agentContexts[0].role, 'review');
  assert.equal(result.value.agentContexts[1].role, 'review-fix');
  assert.equal(result.value.steps[0].name, 'review');
  assert.equal(result.value.steps[0].outputs.reviews[0].id, review.id);
  assert.equal(result.value.steps[0].outputs.reviews[0].verdict, 'pass');
  assert.deepEqual(result.value.steps[0].outputs.reviews[0].reviewSnapshot, snapshot);
  assert.deepEqual(result.value.steps[0].outputs.reviews[0].artifactPaths, review.artifactPaths);
  assert.equal(result.value.steps[0].outputs.reviews[0].source, 'pipeline');
  assert.equal(result.value.repeatReviewContext.mode, 'warm');
  const { intent: _, ...preservedSession } = session;
  assert.deepEqual(result.value.repeatReviewContext.session, { ...preservedSession, mode: 'warm' });
  assert(!('reviewId' in result.value.repeatReviewContext.session));
  for (const key of ['id', 'runnerSessionId', 'runnerSessionPath', 'taskFile'])
    assert.equal(result.value.agentContexts[0][key], original.agentContexts[0][key]);
  assert.deepEqual(
    result.value.repeatReviewContext.artifactRefs,
    original.repeatReviewContext.artifactRefs,
  );
  assert.deepEqual(result.value.qa, original.qa);
});

test('same resolves only from the recorded worker and keeps every review row', () => {
  const plan = [{ ...row, runner: 'same', model: null, effort: null }];
  const recorded = convertReviewConfiguration(
    {
      id: 'known-run',
      flowType: 'dev',
      metrics: { runner: 'codex' },
      engineState: { publishGate: { pendingReviewPlan: plan } },
    },
    'run',
  );
  assert.deepEqual(recorded.unresolved, []);
  assert.deepEqual(recorded.value.engineState.publishGate.reviewSequence, [
    { runner: 'codex', model: null, effort: null, mode: 'cold' },
  ]);
  const primary = convertReviewConfiguration(
    {
      id: 'known-primary',
      flowType: 'fix-bug',
      agentContexts: [
        { role: 'fix-bug', runner: 'claude' },
        { role: 'review', runner: 'codex' },
      ],
      pendingReviewPlan: plan,
    },
    'run',
  );
  assert.deepEqual(primary.unresolved, []);
  assert.equal(primary.value.reviewSequence[0].runner, 'claude');
  for (const document of [
    { id: 'unknown-run', pendingReviewPlan: plan },
    {
      id: 'ambiguous-run',
      flowType: 'dev',
      agentContexts: [
        { role: 'dev', runner: 'codex' },
        { role: 'dev', runner: 'claude' },
      ],
      pendingReviewPlan: plan,
    },
  ]) {
    const result = convertReviewConfiguration(document, 'run');
    assert(result.unresolved.includes('pendingReviewPlan[0].runner'));
    assert.equal(result.value.reviewSequence.length, plan.length);
    assert.equal(result.value.reviewSequence[0].runner, 'same');
  }
});

const historicalRun = () => ({
  id: 'historical-run',
  status: 'done',
  createdAt: '2026-05-01T08:00:00.000Z',
  completedAt: '2026-05-01T09:00:00.000Z',
  steps: [{ name: 'publish', status: 'done', outputs: { artifact: 'review.md' } }],
  decisions: [
    {
      id: 'historical-decision',
      resolvedAt: '2026-05-01T08:59:00.000Z',
      payload: { reviewDepth: { ...policy, requestedBy: 'manual-bypass' } },
    },
  ],
  engineState: {
    publishGate: {
      reviewDepth: { ...policy, requestedBy: 'manual-bypass' },
      independentReviews: [{ id: 'historical-review', verdict: 'pass', crossRunner: false }],
    },
  },
});

test('unmappable completed runs retain their entire original outside runtime admission', () => {
  for (const status of ['done', 'failed', 'cancelled']) {
    const original = { ...historicalRun(), status };
    const before = structuredClone(original);
    assert(parseRunRecordFile(`${original.id}.json`, JSON.stringify(original)));
    const converted = convertReviewConfiguration(original, 'run');
    assert.deepEqual(converted.unresolved, []);
    assert.equal(converted.value.conversionStatus, 'unconvertible-historical');
    assert.equal(converted.value.readOnly, true);
    assert.equal(converted.value.id, original.id);
    assert.deepEqual(converted.value.legacy, before);
    assert.deepEqual(converted.value.legacyUnresolvedFields, [
      'decisions[0].payload.reviewDepth.requestedBy',
      'engineState.publishGate.reviewDepth.requestedBy',
    ]);
    assert.equal(parseRunRecordFile(`${original.id}.json`, JSON.stringify(converted.value)), null);
    assert.deepEqual(original, before);
    assert.deepEqual(convertReviewConfiguration(converted.value, 'run'), {
      value: converted.value,
      fields: [],
      unresolved: [],
    });
  }
});

test('active or undated records still refuse unmappable provenance', () => {
  for (const status of ['monitoring', 'human-gating', 'paused', 'blocked']) {
    const converted = convertReviewConfiguration({ ...historicalRun(), status }, 'run');
    assert.equal(converted.unresolved.length, 2);
    assert(!('legacy' in converted.value));
  }
  for (const completedAt of [undefined, null, 'unknown']) {
    const converted = convertReviewConfiguration({ ...historicalRun(), completedAt }, 'run');
    assert.equal(converted.unresolved.length, 2);
  }
  for (const kind of ['backlog', 'queue', 'project']) {
    const converted = convertReviewConfiguration(historicalRun(), kind);
    assert.equal(converted.unresolved.length, 2);
    assert(!('legacy' in converted.value));
  }
});

test('terminal closeout and native ownership obligations keep unmappable runs admitted', () => {
  for (const [pending, at] of [
    [
      { output: { closedAt: '2026-05-01T09:00:00.000Z', cleanupPending: true } },
      'output.cleanupPending',
    ],
    [{ output: { closeError: 'release failed' } }, 'output.closeError'],
    [{ backlogReconcilePending: true }, 'backlogReconcilePending'],
    [{ reviewWorkspace: { checkoutId: 'owned-checkout' } }, 'reviewWorkspace'],
    [{ agentContexts: [{ nativeSession: { sessionId: 'owned-session' } }] }, 'agentContexts'],
  ]) {
    const original = { ...historicalRun(), ...pending };
    const converted = convertReviewConfiguration(original, 'run');
    assert(converted.unresolved.includes(at));
    assert(!('legacy' in converted.value));
    assert(parseRunRecordFile(`${original.id}.json`, JSON.stringify(converted.value)));
  }
  const settled = convertReviewConfiguration(
    {
      ...historicalRun(),
      output: { cleanupPending: false },
      backlogReconcilePending: false,
      reviewWorkspace: { cleanedAt: '2026-05-01T09:00:00.000Z' },
      agentContexts: [
        { nativeSession: { sessionId: 'closed-session', closedAt: '2026-05-01T09:00:00.000Z' } },
      ],
    },
    'run',
  );
  assert.equal(settled.value.conversionStatus, 'unconvertible-historical');
});

test('a dispatching queue handoff refuses the batch before its historical run becomes invisible', async (t) => {
  const options = await fixture(t);
  const file = path.join(options.runs, 'historical-run.json');
  await write(file, historicalRun());
  await write(options.queue, [{ id: 'handoff', status: 'dispatching', runId: 'historical-run' }]);
  const before = await readFile(file, 'utf8');
  for (const apply of [false, true]) {
    const refused = await migrateReviewConfiguration({ ...options, apply });
    assert.equal(refused.applied, 0);
    assert(
      refused.items
        .find((item) => item.itemId === 'historical-run')
        .unresolved.includes('dispatchQueue.runId'),
    );
    assert.equal(await readFile(file, 'utf8'), before);
    await assert.rejects(stat(file + '.adr063-original'), { code: 'ENOENT' });
  }
  await write(options.queue, [{ id: 'handoff', status: 'cancelled', runId: 'historical-run' }]);
  const settled = await migrateReviewConfiguration(options);
  assert.equal(settled.unresolved, 0);
  assert.equal(settled.items[0].conversionStatus, 'unconvertible-historical');
});

test('historical envelopes are byte-preserving in dry run, backed up on apply and idempotent', async (t) => {
  const options = await fixture(t);
  const file = path.join(options.runs, 'historical-run.json');
  const original = historicalRun();
  await write(file, original);
  const before = await readFile(file, 'utf8');
  const mtime = (await stat(file)).mtimeMs;
  const dry = await migrateReviewConfiguration(options);
  assert.equal(dry.unresolved, 0);
  assert.equal(dry.changed, 1);
  assert.equal(dry.applied, 0);
  assert.equal(dry.items[0].conversionStatus, 'unconvertible-historical');
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await stat(file)).mtimeMs, mtime);
  await assert.rejects(stat(file + '.adr063-original'), { code: 'ENOENT' });

  await write(options.queue, [
    { id: 'active-item', reviewDepth: { ...policy, requestedBy: 'unknown' } },
  ]);
  const refused = await migrateReviewConfiguration({ ...options, apply: true });
  assert.equal(refused.unresolved, 1);
  assert.equal(refused.applied, 0);
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(stat(file + '.adr063-original'), { code: 'ENOENT' });

  await write(options.queue, [{ id: 'active-item', reviewDepth: policy }]);
  const applied = await migrateReviewConfiguration({ ...options, apply: true });
  assert.equal(applied.unresolved, 0);
  assert.equal(applied.applied, 2);
  assert.deepEqual((await read(file)).legacy, original);
  assert.equal(await readFile(file + '.adr063-original', 'utf8'), before);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const rerun = await migrateReviewConfiguration({ ...options, apply: true });
  assert.equal(rerun.changed, 0);
  assert.equal(rerun.applied, 0);
});

test('project defaults migrate without mapping same or manufacturing a retained review', () => {
  const result = convertReviewConfiguration(
    {
      self_review: {
        enabled: true,
        model: 'opus',
        max_retries: 2,
        session_policy: 'warm-per-reviewer',
      },
      publication_review: { dev: { minimum_independent_reviews: 2, require_cross_runner: true } },
      workflow_defaults: {
        'review-pr': {
          review: { scope: 'incremental', sessionIntent: 'resume', validationDepth: 'static-code' },
        },
      },
    },
    'project',
  );
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.value.review, {
    enabled: true,
    model: 'opus',
    max_retries: 2,
    mode: 'cold',
  });
  assert.deepEqual(result.value.publication_review.dev, { minimum_reviews: 2 });
  assert.deepEqual(
    convertReviewConfiguration(
      {
        publication_review: { dev: { minimum_independent_reviews: 0, require_cross_runner: true } },
      },
      'project',
    ).value.publication_review.dev,
    { minimum_reviews: 1 },
  );
  assert.deepEqual(result.value.workflow_defaults['review-pr'].review, { mode: 'cold' });
  assert.deepEqual(
    convertReviewConfiguration({ self_review: { runner: 'same' } }, 'project').unresolved,
    ['self_review.runner'],
  );
  const warm = convertReviewConfiguration(
    { reviewSequence: [{ runner: 'codex', model: null, effort: null, mode: 'warm' }] },
    'queue',
  );
  assert.deepEqual(warm.unresolved, ['reviewSequence']);
  assert.equal(warm.value.reviewSequence[0].mode, 'warm');
  assert(!('reviewSequenceContext' in warm.value));
  const lineage = { repository: 'example/app', prNumber: 42, reviewId: 'already-recorded' };
  const bound = convertReviewConfiguration(
    {
      reviewSequence: [{ runner: 'codex', model: null, effort: null, mode: 'warm' }],
      reviewSequenceContext: { reviewLineages: [lineage] },
    },
    'queue',
  );
  assert.deepEqual(bound.unresolved, []);
  assert.deepEqual(bound.value.reviewSequenceContext.reviewLineages[0], lineage);
  assert.deepEqual(convertReviewConfiguration({ reviewScope: 'unknown' }, 'run').unresolved, [
    'reviewScope',
  ]);
});

test('PR intake choices keep identities, resource limits and publication metadata with COLD defaults', () => {
  const result = convertReviewConfiguration(
    {
      teams: [
        {
          id: 'team-1',
          config: {
            execution: {
              workspacePolicy: { kind: 'pool', allowedMachines: ['fixture'] },
              models: [{ runner: 'codex', model: 'gpt-6.1-sol', allowedMachines: ['fixture'] }],
            },
            review: {
              sessionIntent: 'resume',
              scope: 'incremental',
              validationDepth: 'static-code',
              publishReview: true,
            },
          },
        },
      ],
      submissions: [
        {
          id: 'submission-1',
          request: {
            idempotencyKey: 'unchanged',
            review: {
              sessionIntent: 'reset',
              scope: 'full',
              workflow: 'qa',
              qaProfileId: 'changes',
            },
          },
        },
      ],
    },
    'pr-rules',
  );
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.value.teams[0].config.execution.models[0], {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: null,
    mode: 'cold',
    allowedMachines: ['fixture'],
  });
  assert.deepEqual(result.value.teams[0].config.review, { publishReview: true, mode: 'cold' });
  assert.deepEqual(result.value.submissions[0].request.review, {
    workflow: 'qa',
    qaProfileId: 'changes',
    mode: 'cold',
  });
  assert.equal(result.value.submissions[0].request.idempotencyKey, 'unchanged');
  assert.equal(result.value.teams[0].id, 'team-1');
  const missingQa = convertReviewConfiguration(
    {
      teams: [
        {
          config: {
            review: { sessionIntent: 'resume', scope: 'incremental', validationDepth: 'full-live' },
          },
        },
      ],
    },
    'pr-rules',
  );
  assert.deepEqual(missingQa.unresolved, ['teams[0].config.review.qaProfileId']);
});

test('dry-run is byte-preserving; apply is backed up, scoped and idempotent on owned fixtures', async (t) => {
  const options = await fixture(t);
  await write(options.backlog, [
    {
      id: 'backlog-1',
      reviewDepth: policy,
      pendingReviewPlan: [row],
      apiToken: 'PRIVATE_VALUE_MUST_NOT_BE_PRINTED',
    },
  ]);
  await write(options.queue, [{ id: 'queue-1', pendingReviewPlan: [row] }]);
  await write(path.join(options.runs, 'run-1.json'), {
    id: 'run-1',
    status: 'self-reviewing',
    agentContexts: [{ id: 'ctx-1', role: 'self-review' }],
  });
  await mkdir(path.join(options.runs, 'archive'));
  await write(path.join(options.runs, 'archive', 'old-run.json'), {
    id: 'old-run',
    status: 'done',
    agentContexts: [{ id: 'old-ctx', role: 'self-review-fix' }],
  });
  await write(path.join(options.projects, 'example', 'project.json'), {
    self_review: { enabled: true },
  });
  await write(path.join(options.root, '.pr-rules.json'), {
    teams: [
      { id: 'team-1', config: { review: { sessionIntent: 'resume', scope: 'incremental' } } },
    ],
    rules: [],
    intents: [],
  });
  const unrelated = path.join(options.root, 'orchestrator-verdict.json');
  await write(unrelated, { reviewDepth: policy, verdict: 'APPROVE' });
  const before = await readFile(options.backlog, 'utf8');
  const mtime = (await stat(options.backlog)).mtimeMs;
  const dry = JSON.parse(
    execFileSync(process.execPath, [script, '--root', options.root], { encoding: 'utf8' }),
  );
  assert.equal(dry.applied, 0);
  assert.equal(dry.changed, 6);
  assert.equal(dry.unresolved, 0);
  assert(!JSON.stringify(dry).includes('PRIVATE_VALUE'));
  assert.equal(await readFile(options.backlog, 'utf8'), before);
  assert.equal((await stat(options.backlog)).mtimeMs, mtime);
  const applied = await migrateReviewConfiguration({ ...options, apply: true });
  assert.equal(applied.applied, 6);
  assert.equal(
    (await read(path.join(options.runs, 'archive', 'old-run.json'))).agentContexts[0].role,
    'review-fix',
  );
  assert.equal(await readFile(options.backlog + '.adr063-original', 'utf8'), before);
  assert.equal((await stat(options.backlog)).mode & 0o777, 0o600);
  assert.equal((await read(options.backlog))[0].id, 'backlog-1');
  assert.deepEqual(await read(unrelated), { reviewDepth: policy, verdict: 'APPROVE' });
  const rerun = await migrateReviewConfiguration({ ...options, apply: true });
  assert.equal(rerun.changed, 0);
  assert.equal(rerun.applied, 0);
});

test('same-runner rows and incompatible configs refuse the entire batch before any write', async (t) => {
  const options = await fixture(t);
  await write(options.backlog, [{ id: 'ok', reviewDepth: policy }]);
  await write(options.queue, [
    { id: 'unresolved-item', pendingReviewPlan: [{ ...row, runner: 'same' }] },
  ]);
  const before = await readFile(options.backlog, 'utf8');
  const refused = spawnSync(process.execPath, [script, '--root', options.root, '--apply'], {
    encoding: 'utf8',
  });
  assert.equal(refused.status, 2);
  const report = JSON.parse(refused.stdout);
  assert.equal(report.applied, 0);
  assert(
    report.items
      .find((item) => item.itemId === 'unresolved-item')
      .unresolved.includes('pendingReviewPlan[0].runner'),
  );
  assert.equal(await readFile(options.backlog, 'utf8'), before);
  await assert.rejects(stat(options.backlog + '.adr063-original'), { code: 'ENOENT' });
  assert(
    convertReviewConfiguration(
      { reviewDepth: policy, reviewPolicy: { minimumReviews: 99 } },
      'backlog',
    ).unresolved.includes('reviewPolicy'),
  );
  assert(
    convertReviewConfiguration(
      { pendingReviewPlan: [{ ...row, validationDepth: 'full-live' }] },
      'backlog',
    ).unresolved.includes('pendingReviewPlan[0].validationDepth'),
  );
});
