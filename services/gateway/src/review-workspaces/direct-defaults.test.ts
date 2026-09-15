import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { Principal, PRWorkspaceExecutionProfile } from '@farmslot/protocol';

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
    '---\nplatforms: [cli]\nrunMode: autonomous\n---\n\n- [ ] Complete selected work.\n',
  );
const execution: PRWorkspaceExecutionProfile = {
  workspacePolicy: { kind: 'pool', allowedMachines: ['one', 'two'] },
  transport: 'native',
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
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
  path.join(root, '.farm-status.json'),
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
  FARMSLOT_TEST_STATUS_FILE: path.join(root, '.farm-status.json'),
  PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
});
after(() => rmSync(root, { recursive: true, force: true }));
const { constrainDirectWorkflowExecution, resolveDirectWorkflowDefaults } =
  await import('./direct-defaults.js');
const { loadProjectConfig } = await import('../fleet/state.js');
const { createRun, deleteRun } = await import('../runs/store.js');
const { dispatchPreview } = await import('../methods/dispatch/preview.js');
const { dispatchQueueAdd } = await import('../methods/dispatch/queue.js');
const { runCreate } = await import('../methods/run.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const queue = await import('../backlog/dispatch-queue.js');
const asOwner = <T>(operation: () => T) =>
  runWithSessionOriginator({ id: 'owner' } as Principal, operation);
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
  await queue.loadQueue({ kind: 'principal', principalId: 'owner' });
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

test('legacy full-live preview retains its slot path and template', async () => {
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
  assert.equal(result.preview.flowType, 'review-pr');
  assert.equal(result.preview.slotId, 'runtime');
  assert.equal(result.preview.executionTemplate?.id, 'review-pr/default');
  assert.equal(result.preview.reviewWorkspace, undefined);
});

test('full-live create and queue retain slot, depth and caller selections under static farm defaults', async (t) => {
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
  assert.deepEqual(selected.params, runtime);
  assert.equal(selected.execution, undefined);
  const { run } = await asOwner(() => runCreate(runtime, () => {}, { awaitPersist: true }));
  t.after(async () => {
    run.status = 'cancelled';
    await deleteRun(run.id);
  });
  assert.equal(run.flowType, 'review-pr');
  assert.equal(run.reviewValidationDepth, 'full-live');
  assert.equal(run.slotId, 'runtime');
  assert.equal(run.reviewWorkspaceTarget, undefined);
  assert.equal(run.executionTemplate?.id, 'review-pr/default');
  assert.equal(run.metrics.model, 'gpt-6-astra');
  assert.equal(run.effort, 'high');
  const queued = await asOwner(() =>
    dispatchQueueAdd({ ...runtime, ticketOrPr: 'example/app#43' }),
  );
  t.after(() => queue.removeQueueItemInternalNow(queued.item.id, 'test-cleanup'));
  assert.equal(queued.item.flowType, 'review-pr');
  assert.equal(queued.item.reviewValidationDepth, 'full-live');
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
