import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type {
  Principal,
  PRWorkspaceExecutionProfile,
  ReviewRequestContext,
  ReviewSequence,
} from '@farmslot/protocol';
import { executionModelFromSelection } from '@farmslot/review-dispatch';

import { GatewayMethodError } from '../core/method-error.js';

const unhealthyMachines = new Set<string>();
mock.module('../runners/native/review-health.js', {
  namedExports: {
    assertReviewNativeRunnerHealthy: async (input: { machine: string }) => {
      if (unhealthyMachines.has(input.machine))
        throw new GatewayMethodError(
          'NATIVE_SESSION_ERROR',
          `Native runner on ${input.machine} is unhealthy`,
        );
    },
  },
});

const root = mkdtempSync(path.join(tmpdir(), 'direct-review-defaults-'));
for (const directory of [
  'scripts',
  'services/gateway',
  'pool',
  'projects/farm/shared/review-pr',
  'projects/farm/shared/validation',
  'repo',
  'bin',
])
  mkdirSync(path.join(root, directory), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(
  path.join(root, 'bin/gh'),
  String.raw`#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]!=='api'||args.some(arg=>['POST','PATCH','PUT','DELETE'].includes(arg))) throw new Error('Fixture refuses non-read GitHub commands');
const body={number:42,title:'Fixture change',state:'open',body:'',user:{login:'fixture'},labels:[],head:{sha:'a'.repeat(40)},base:{sha:'b'.repeat(40)}};
if(args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify(body));
`,
  { mode: 0o700 },
);
for (const flow of ['review-pr', 'validation'])
  writeFileSync(
    path.join(root, `projects/farm/shared/${flow}/default.md`),
    '---\nplatforms: [cli]\n---\n\n- [ ] Complete selected work.\n',
  );
const execution: PRWorkspaceExecutionProfile = {
  workspacePolicy: { kind: 'pool', allowedMachines: ['one', 'two'] },
  transport: 'native',
  models: [{ mode: 'cold' as const, runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
};
const raw = {
  name: 'farm',
  repo_url: 'https://github.com/example/app.git',
  ci: { repo: 'example/app' },
  static_review: { template_id: 'review-pr/default' },
  execution_templates: {
    sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
  },
  workflow_defaults: { 'review-pr': { execution } },
  qa: {
    default_profile: 'pr',
    profiles: [{ id: 'pr', title: 'PR QA', template_id: 'validation/default' }],
  },
};
const projectPath = path.join(root, 'projects/farm/project.json');
writeFileSync(projectPath, JSON.stringify(raw));
for (const machine of ['one', 'two'])
  writeFileSync(
    path.join(root, `pool/${machine}.json`),
    JSON.stringify({
      machine,
      project: 'farm',
      host: 'localhost',
      platform: 'cli',
      slots: [],
      review_workspaces: { max_concurrent: 1 },
    }),
  );
writeFileSync(
  path.join(root, 'pool/runtime.json'),
  JSON.stringify({
    machine: 'runtime-host',
    project: 'farm',
    host: 'localhost',
    platform: 'cli',
    slots: [
      {
        id: 'runtime',
        enabled: true,
        repo: path.join(root, 'repo'),
        session: 'isolated-runtime',
        resources: {},
      },
    ],
  }),
);
writeFileSync(
  path.join(root, 'fixture-status.json'),
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: 'runtime',
        machine: 'runtime-host',
        project: 'farm',
        platform: 'cli',
        enabled: true,
        lifecycle: 'ready',
        agent: 'idle',
        branch: 'main',
        runner: 'claude',
        model: 'sonnet',
      },
    ],
  }),
);
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_DISPATCH_QUEUE_FILE: path.join(root, 'queue.json'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'owner',
  FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'fixture-status.json'),
  PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
});
after(() => rmSync(root, { recursive: true, force: true }));
const { constrainDirectWorkflowExecution, resolveDirectWorkflowDefaults } =
  await import('./direct-defaults.js');
const { loadProjectConfig } = await import('../fleet/state.js');
const { createRun, deleteRun } = await import('../runs/store.js');
const { dispatchPreview } = await import('../methods/dispatch/preview.js');
const { dispatchQueueAdd } = await import('../methods/dispatch/queue.js');
const { runCreate, planRunCreation } = await import('../methods/run.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const queue = await import('../backlog/dispatch-queue.js');
const owner: Principal = {
  id: 'owner',
  subject: { type: 'service', displayName: 'Owner' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const asOwner = <T>(operation: () => T) => runWithSessionOriginator(owner, operation);
const request = {
  flowType: 'review-pr' as const,
  project: 'farm',
  ticketOrPr: 'example/app#42',
  mode: 'autonomous' as const,
};

test('flat constraints retain exact machines, models, efforts and native-profile identity', () => {
  const nativeProfile = {
    executionNodeId: 'local',
    runner: 'codex',
    profileId: 'reviewer',
    accountContextId: '00000000-0000-0000-0000-000000000001',
  };
  const selected = constrainDirectWorkflowExecution(execution, {
    ...request,
    reviewWorkspaceTarget: { machine: 'two' },
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    nativeProfile,
  });
  assert.deepEqual(selected.workspacePolicy, { kind: 'exact', machine: 'two' });
  assert.deepEqual(selected.nativeProfile, nativeProfile);
  for (const patch of [
    { slotId: 'runtime' },
    { allowedSlots: ['runtime'] },
    { reviewWorkspaceTarget: { machine: 'outside' } },
    { runner: 'claude' },
    { model: 'other' },
    { effort: 'low' },
    { transport: 'tmux' as const },
  ]) {
    assert.throws(() => constrainDirectWorkflowExecution(execution, { ...request, ...patch }));
  }
});

test('farm pool selects an available host and queue admission retains the full declared pool', async (t) => {
  const busy = createRun(
    { ...request, ticketOrPr: 'example/app#1', reviewWorkspaceTarget: { machine: 'one' } },
    { deferBackgroundPersist: true },
  );
  t.after(async () => {
    busy.status = 'cancelled';
    await deleteRun(busy.id);
  });
  const result = await resolveDirectWorkflowDefaults(request, await loadProjectConfig('farm'), {
    purpose: 'run',
    ownerId: 'owner',
  });
  assert.equal(result.params.reviewWorkspaceTarget?.machine, 'two');
  assert.deepEqual(result.execution, execution);
  const queued = await asOwner(() => dispatchQueueAdd(request));
  t.after(() => queue.removeQueueItemInternalNow(queued.item.id, 'test-cleanup'));
  assert.equal(queued.item.reviewWorkspaceTarget?.machine, 'two');
  assert.deepEqual(queued.item.workflowExecution, execution);
  await queue.persistQueueNow();
  await queue.loadQueue();
  assert.deepEqual(
    queue.getQueueSnapshot().find((item) => item.id === queued.item.id)?.workflowExecution,
    execution,
  );
});

test('preview and run creation use farm choices and reject public snapshot forgery', async (t) => {
  const preview = await asOwner(() => dispatchPreview(request));
  assert.equal(preview.preview.slotId, null);
  assert.equal(preview.preview.reviewWorkspace?.machine, 'one');
  assert.equal(preview.preview.runner, 'codex');
  const { run } = await asOwner(() => runCreate(request, () => {}, { awaitPersist: true }));
  t.after(async () => {
    run.status = 'cancelled';
    await deleteRun(run.id);
  });
  assert.equal(run.slotId, null);
  assert.deepEqual(run.workflowExecution, execution);
  assert.equal(run.transport, 'native');
  assert.equal(run.metrics.model, 'gpt-6-astra');
  await assert.rejects(
    asOwner(() => dispatchQueueAdd({ ...request, workflowExecution: execution } as never)),
    /handoff metadata/,
  );
  await assert.rejects(
    asOwner(() => runCreate({ ...request, workflowExecution: execution } as never, () => {})),
    /cannot be supplied/,
  );
});

test('legacy full-live preview selects QA template while retaining its explicit slot', async () => {
  const result = await asOwner(() =>
    dispatchPreview({
      ...request,
      reviewValidationDepth: 'full-live',
      slotId: 'runtime',
      runner: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
    }),
  );
  assert.equal(result.preview.flowType, 'qa');
  assert.equal(result.preview.slotId, 'runtime');
  assert.equal(result.preview.executionTemplate?.id, 'validation/default');
  assert.equal(result.preview.reviewWorkspace, undefined);
});

test('full-live create and queue migrate to QA while retaining slot and caller selections', async (t) => {
  const runtime = {
    ...request,
    slotId: 'runtime',
    reviewValidationDepth: 'full-live' as const,
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
  };
  const selected = await resolveDirectWorkflowDefaults(runtime, await loadProjectConfig('farm'), {
    purpose: 'run',
  });
  assert.equal(selected.params.flowType, 'qa');
  assert.equal(selected.params.slotId, runtime.slotId);
  assert.equal(selected.params.reviewValidationDepth, undefined);
  assert.equal(selected.execution, undefined);
  const { run } = await asOwner(() => runCreate(runtime, () => {}, { awaitPersist: true }));
  t.after(async () => {
    run.status = 'cancelled';
    await deleteRun(run.id);
  });
  assert.equal(run.flowType, 'qa');
  assert.equal(run.reviewValidationDepth, undefined);
  assert.equal(run.reviewQaContract?.legacy?.validationDepth, 'full-live');
  assert.equal(run.slotId, 'runtime');
  assert.equal(run.reviewWorkspaceTarget, undefined);
  assert.equal(run.executionTemplate?.id, 'validation/default');
  assert.equal(run.metrics.model, 'gpt-6-astra');
  assert.equal(run.effort, 'high');
  const queued = await asOwner(() =>
    dispatchQueueAdd({ ...runtime, ticketOrPr: 'example/app#43' }),
  );
  t.after(() => queue.removeQueueItemInternalNow(queued.item.id, 'test-cleanup'));
  assert.equal(queued.item.flowType, 'qa');
  assert.equal(queued.item.reviewValidationDepth, undefined);
  assert.equal(queued.item.reviewQaContract?.legacy?.validationDepth, 'full-live');
  assert.equal(queued.item.slotId, 'runtime');
  assert.equal(queued.item.reviewWorkspaceTarget, undefined);
  await assert.rejects(
    asOwner(() => runCreate({ ...runtime, reviewWorkspaceTarget: { machine: 'one' } }, () => {})),
    /without slot placement/,
  );
});

test('omitted workspace mode and explicit template constraints agree across all entry points', async (t) => {
  const { mode: _mode, ...withoutMode } = request;
  const preview = await asOwner(() => dispatchPreview(withoutMode));
  assert.equal(preview.preview.executionTemplate?.id, 'review-pr/default');
  const queued = await asOwner(() =>
    dispatchQueueAdd({ ...withoutMode, ticketOrPr: 'example/app#50' }),
  );
  t.after(() => queue.removeQueueItemInternalNow(queued.item.id, 'test-cleanup'));
  assert.equal(queued.item.mode, 'autonomous');
  const { run } = await asOwner(() => runCreate(withoutMode, () => {}, { awaitPersist: true }));
  t.after(async () => {
    run.status = 'cancelled';
    await deleteRun(run.id);
  });
  assert.equal(run.mode, 'autonomous');
  for (const invoke of [
    dispatchPreview,
    dispatchQueueAdd,
    (params: typeof request) => runCreate(params, () => {}),
  ]) {
    await assert.rejects(
      asOwner(() =>
        invoke({ ...request, executionTemplateId: 'review-pr/other' } as typeof request),
      ),
      /configured static-review template/,
    );
  }
});

test('a full eligible machine retains its capacity refusal ahead of an invalid alternative', async (t) => {
  const busy = createRun(
    { ...request, ticketOrPr: 'example/app#60', reviewWorkspaceTarget: { machine: 'one' } },
    { deferBackgroundPersist: true },
  );
  t.after(async () => {
    busy.status = 'cancelled';
    await deleteRun(busy.id);
  });
  const profile: PRWorkspaceExecutionProfile = {
    ...execution,
    workspacePolicy: { kind: 'pool', allowedMachines: ['one', 'missing'] },
  };
  const project = await loadProjectConfig('farm');
  await assert.rejects(
    resolveDirectWorkflowDefaults(request, project, {
      purpose: 'run',
      ownerId: 'owner',
      execution: profile,
    }),
    { code: 'REVIEW_WORKSPACE_CAPACITY' },
  );
  const queued = await resolveDirectWorkflowDefaults(request, project, {
    purpose: 'queue',
    ownerId: 'owner',
    execution: profile,
  });
  assert.equal(queued.params.reviewWorkspaceTarget?.machine, 'one');
  assert.equal(queued.admission?.active, 1);
});

test('an issued offline first alternative does not hide a healthy authorized machine', async (t) => {
  const { createGatewayAuthRuntime } = await import('../security/auth.js');
  const auth = createGatewayAuthRuntime({
    FARMSLOT_HOME: process.env.FARMSLOT_HOME!,
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  const owner = auth.writer.createPrincipal(
    { type: 'person', displayName: 'Offline alternative test' },
    [],
  );
  const node = auth.writer.createPrincipal(
    { type: 'node', machine: 'one', displayName: 'Offline node', nativeOwnerPrincipalId: owner.id },
    [],
  );
  const credential = auth.writer.issueCredential(node.id, 'offline alternative test');
  const poolFile = path.join(root, 'pool/one.json');
  const previous = await (await import('node:fs/promises')).readFile(poolFile, 'utf8');
  const priorOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  writeFileSync(poolFile, JSON.stringify({ ...JSON.parse(previous), host: 'offline.invalid' }));
  t.after(() => {
    writeFileSync(poolFile, previous);
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = priorOwner;
    auth.writer.revokeCredential(credential.record.id);
  });
  const project = await loadProjectConfig('farm');
  for (const purpose of ['preview', 'queue', 'run'] as const) {
    const result = await resolveDirectWorkflowDefaults(request, project, {
      purpose,
      ownerId: owner.id,
    });
    assert.equal(result.params.reviewWorkspaceTarget?.machine, 'two');
  }
  const { resolvePRExecution } = await import('../backlog/pr-execution.js');
  const result = await resolvePRExecution('farm', 'example/app', [execution], {
    ownerId: owner.id,
  });
  assert.deepEqual(
    result.choices.map((choice) => choice.machine),
    ['two'],
  );
  assert.deepEqual(result.errors, []);
});

test('run and queued dispatch preserve primary and additional review context separately', async (t) => {
  const reviewContext: ReviewRequestContext = {
    reviewLineages: [{ repository: 'example/app', prNumber: 42, reviewId: 'primary-review' }],
  };
  const reviewSequenceContext: ReviewRequestContext = {
    reviewLineages: [{ repository: 'example/app', prNumber: 42, reviewId: 'additional-review' }],
  };
  const reviewSequence: ReviewSequence = [
    { runner: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'warm' },
  ];
  const input = { ...request, reviewContext, reviewSequence, reviewSequenceContext };
  const queued = await asOwner(() => dispatchQueueAdd(input));
  t.after(() => queue.removeQueueItemInternalNow(queued.item.id, 'test-cleanup'));
  assert.deepEqual(queued.item.reviewContext, reviewContext);
  assert.deepEqual(queued.item.reviewSequenceContext, reviewSequenceContext);
  await queue.persistQueueNow();
  await queue.loadQueue();
  const saved = queue.getQueueSnapshot().find((item) => item.id === queued.item.id)!;
  assert.deepEqual(saved.reviewContext, reviewContext);
  assert.deepEqual(saved.reviewSequenceContext, reviewSequenceContext);
  const { run } = await asOwner(() => runCreate(input, () => {}, { awaitPersist: true }));
  t.after(async () => {
    run.status = 'cancelled';
    await deleteRun(run.id);
  });
  assert.deepEqual(run.reviewContext, reviewContext);
  assert.deepEqual(run.engineState?.publishGate?.reviewSequenceContext, reviewSequenceContext);
  assert.deepEqual(run.engineState?.publishGate?.reviewSequence, reviewSequence);
});

test('delayed queue dispatch uses frozen alternatives when farm defaults change', async (t) => {
  const queued = await asOwner(() => dispatchQueueAdd(request));
  const busy = createRun(
    { ...request, ticketOrPr: 'example/app#2', reviewWorkspaceTarget: { machine: 'one' } },
    { deferBackgroundPersist: true },
  );
  t.after(async () => {
    busy.status = 'cancelled';
    await deleteRun(busy.id);
    await queue.removeQueueItemInternalNow(queued.item.id, 'test-cleanup');
    writeFileSync(projectPath, JSON.stringify(raw));
  });
  writeFileSync(
    projectPath,
    JSON.stringify({
      ...raw,
      workflow_defaults: {
        'review-pr': {
          execution: { ...execution, workspacePolicy: { kind: 'exact', machine: 'outside' } },
        },
      },
    }),
  );
  let selected: string | undefined;
  queue.initDispatchQueue(
    () => {},
    async (item) => {
      selected = item.reviewWorkspaceTarget?.machine;
      const result = await asOwner(() =>
        runCreate(
          {
            ...request,
            reviewWorkspaceTarget: item.reviewWorkspaceTarget,
            runner: item.runner,
            model: item.model,
            effort: item.effort,
            transport: item.transport,
            nativeProfile: item.nativeProfile,
          },
          () => {},
          { workflowExecution: item.workflowExecution, awaitPersist: true },
        ),
      );
      assert.deepEqual(
        result.run.workflowExecution,
        execution,
        'Run must retain the original queued policy after selecting one host',
      );
      result.run.status = 'cancelled';
      await deleteRun(result.run.id);
      await queue.removeQueueItemInternalNow(item.id, 'captured-test-selection');
    },
  );
  await queue.tryDispatchNext();
  assert.equal(selected, 'two');
});

test('queued QA pool selection stays unpinned while explicit slot requests survive', async () => {
  const project = await loadProjectConfig('farm');
  const input = { ...request, flowType: 'qa' as const };
  const execution = {
    slotPolicy: { kind: 'pool' as const, allowedSlots: ['runtime'] },
    models: [{ mode: 'cold' as const, runner: 'codex', model: 'gpt-5.6-luna', effort: 'low' }],
  };
  const queued = await resolveDirectWorkflowDefaults(input, project, {
    purpose: 'queue',
    execution,
  });
  assert.equal(queued.params.slotId, undefined);
  assert.deepEqual(queued.params.allowedSlots, ['runtime']);
  const pinned = await resolveDirectWorkflowDefaults({ ...input, slotId: 'runtime' }, project, {
    purpose: 'queue',
    execution,
  });
  assert.equal(pinned.params.slotId, 'runtime');
  const immediate = await resolveDirectWorkflowDefaults(input, project, {
    purpose: 'run',
    execution,
  });
  assert.equal(immediate.params.slotId, 'runtime');
  const preview = await resolveDirectWorkflowDefaults(input, project, {
    purpose: 'preview',
    execution,
  });
  assert.equal(preview.params.slotId, 'runtime');
});

test('direct portable pools bind before explicit machine narrowing and keep defaults', async () => {
  const portable = { ...execution, workspacePolicy: { kind: 'pool' as const } };
  const config = await loadProjectConfig('farm');
  const resolved = await resolveDirectWorkflowDefaults(
    { ...request, reviewWorkspaceTarget: { machine: 'two' } },
    config,
    { purpose: 'preview', ownerId: 'owner', execution: portable },
  );
  assert.equal(resolved.params.reviewWorkspaceTarget?.machine, 'two');
  assert.equal(resolved.params.runner, execution.models[0].runner);
  assert.equal(resolved.params.model, execution.models[0].model);
  assert.equal(resolved.params.effort, execution.models[0].effort);
  await assert.rejects(
    resolveDirectWorkflowDefaults(
      { ...request, reviewWorkspaceTarget: { machine: 'unregistered' } },
      config,
      { purpose: 'preview', ownerId: 'owner', execution: portable },
    ),
    /outside.*policy/,
  );
});

test('queued portable defaults retain registry binding until dispatch', async () => {
  const portable = { ...execution, workspacePolicy: { kind: 'pool' as const } };
  const resolved = await resolveDirectWorkflowDefaults(request, await loadProjectConfig('farm'), {
    purpose: 'queue',
    ownerId: 'owner',
    execution: portable,
  });
  assert.deepEqual(resolved.execution?.workspacePolicy, { kind: 'pool' });
  assert.equal(resolved.params.model, execution.models[0].model);
});

test('queued portable policies retain model alternatives for future registry admission', async () => {
  const portable = {
    ...execution,
    workspacePolicy: { kind: 'pool' as const },
    models: [{ ...execution.models[0], allowedMachines: ['later'] }, ...execution.models],
  };
  const resolved = await resolveDirectWorkflowDefaults(request, await loadProjectConfig('farm'), {
    purpose: 'queue',
    ownerId: 'owner',
    execution: portable,
  });
  assert.deepEqual(resolved.execution, portable);
});

test('direct admission resolves null defaults and retains them in the saved execution policy', async () => {
  const defaults: PRWorkspaceExecutionProfile = {
    ...execution,
    models: [{ runner: 'codex', model: null, effort: null, mode: 'cold' }],
  };
  const expected = executionModelFromSelection(defaults.models[0]);
  const resolved = await resolveDirectWorkflowDefaults(request, await loadProjectConfig('farm'), {
    purpose: 'run',
    ownerId: 'owner',
    execution: defaults,
  });
  assert.equal(resolved.params.model, expected.model);
  assert.equal(resolved.params.effort, expected.effort ?? undefined);
  assert.deepEqual(resolved.execution, defaults);
  assert.equal(resolved.execution!.models[0].model, null);
  assert.equal(resolved.execution!.models[0].effort, null);
});

test('source replanning excludes its own provisional review but keeps foreign capacity', async (t) => {
  const same = createRun(
    { ...request, ticketOrPr: 'example/app#70', reviewWorkspaceTarget: { machine: 'one' } },
    { deferBackgroundPersist: true },
  );
  let foreign: typeof same | undefined;
  t.after(async () => {
    for (const run of [same, foreign])
      if (run) {
        run.status = 'cancelled';
        await deleteRun(run.id);
      }
  });
  const params = {
    ...request,
    ticketOrPr: same.ticketOrPr,
    reviewWorkspaceTarget: { machine: 'one' },
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    transport: 'native' as const,
  };
  await assert.rejects(
    asOwner(() => planRunCreation({ ...params })),
    { code: 'REVIEW_WORKSPACE_CAPACITY' },
  );
  const planned = await asOwner(() => planRunCreation({ ...params }, { replanningRunId: same.id }));
  assert.equal(planned.workspaceAdmission?.active, 0);
  assert.equal(planned.params.reviewWorkspaceTarget?.machine, 'one');
  foreign = createRun(
    { ...request, ticketOrPr: 'example/app#71', reviewWorkspaceTarget: { machine: 'one' } },
    { deferBackgroundPersist: true },
  );
  await assert.rejects(
    asOwner(() => planRunCreation({ ...params }, { replanningRunId: same.id })),
    { code: 'REVIEW_WORKSPACE_CAPACITY' },
  );
});

test('automatic native review skips unhealthy machines across run, queue and monitored PR choices', async (t) => {
  unhealthyMachines.add('one');
  t.after(() => unhealthyMachines.clear());
  const project = await loadProjectConfig('farm');
  const result = await resolveDirectWorkflowDefaults(request, project, {
    purpose: 'run',
    ownerId: 'owner',
  });
  assert.equal(result.params.reviewWorkspaceTarget?.machine, 'two');
  const queuedSelection = await resolveDirectWorkflowDefaults(request, project, {
    purpose: 'queue',
    ownerId: 'owner',
  });
  assert.equal(queuedSelection.params.reviewWorkspaceTarget?.machine, 'two');
  let dispatchedMachine: string | undefined;
  queue.initDispatchQueue(
    () => {},
    async (item) => {
      dispatchedMachine = item.reviewWorkspaceTarget?.machine;
      await queue.removeQueueItemInternalNow(item.id, 'captured-health-selection');
    },
  );
  const queued = await asOwner(() =>
    dispatchQueueAdd({ ...request, ticketOrPr: 'example/app#92' }),
  );
  t.after(() => queue.removeQueueItemInternalNow(queued.item.id, 'test-cleanup'));
  await queue.tryDispatchNext();
  assert.equal(dispatchedMachine, 'two');

  const { resolvePRExecution } = await import('../backlog/pr-execution.js');
  const resolved = await resolvePRExecution('farm', 'example/app', [execution], {
    ownerId: 'owner',
  });
  assert.deepEqual(
    resolved.choices.map((choice) => ('machine' in choice ? choice.machine : undefined)),
    ['two'],
  );
  unhealthyMachines.add('two');
  await assert.rejects(
    resolveDirectWorkflowDefaults(request, project, { purpose: 'run', ownerId: 'owner' }),
    /Native runner.*unhealthy/,
  );
  const explicit = await resolveDirectWorkflowDefaults(
    { ...request, reviewWorkspaceTarget: { machine: 'one' } },
    project,
    { purpose: 'run', ownerId: 'owner' },
  );
  assert.equal(
    explicit.params.reviewWorkspaceTarget?.machine,
    'one',
    'explicit direct placement permits a verified operator retry',
  );
});
