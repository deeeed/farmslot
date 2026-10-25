// Private protocol fixture. Only Git and task files are real slot operations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';

import type { Run, RunCreateResult, RunGetResult, SlotStatus } from '@farmslot/protocol';
import type { GatewayConnection } from '../../../packages/cli/src/gateway-client.js';

const home = await mkdtemp(path.join(os.tmpdir(), 'finished-slot-rpc-'));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/finished-slot-proof');
const workspace = path.join(home, 'workspace');
const repo = path.join(home, 'checkout');
const project = 'finished-proof';
const slot = 'finished-proof-slot';
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_ROOT: workspace,
  FARMSLOT_WORKSPACE: '',
  FARMSLOT_HOME: path.join(home, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(workspace, 'projects'),
  FARMSLOT_POOL_DIR: path.join(workspace, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(home, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(home, 'status.json'),
});
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'scratch.json'), JSON.stringify({ home }) + '\n');
for (const relative of [
  'scripts',
  'services/gateway',
  'pool',
  `projects/${project}/templates/worker`,
])
  await mkdir(path.join(workspace, relative), { recursive: true });
await writeFile(path.join(workspace, 'CLAUDE.md'), '# Private fixture\n');
await writeFile(path.join(workspace, 'scripts/dev.sh'), '# Private fixture\n');
await writeFile(
  path.join(workspace, 'services/gateway/package.json'),
  '{"name":"@farmslot/gateway"}',
);
await writeFile(
  path.join(workspace, `projects/${project}/project.json`),
  JSON.stringify({
    name: project,
    default_branch: 'main',
    task_dir: 'temp/tasks',
    paths: { runtime_dir: 'temp/runtime' },
    hooks: {},
    scripted: { commands: { proof: { command: 'true' } } },
    execution_templates: { sources: [] },
    prepare: {
      default: 'fixture',
      compatibility_profile: 'fixture',
      profiles: {
        fixture: { label: 'Fixture Git only', phases: ['git'] },
      },
    },
  }),
);
await writeFile(
  path.join(workspace, `projects/${project}/templates/worker/fix-bug.md`),
  '---\nplatforms: [cli]\n---\n# Fix scope\n\n- [ ] 1. Prove the supplied acceptance criteria.\n',
);
await writeFile(
  path.join(workspace, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project,
    platform: 'cli',
    slots: [{ id: slot, repo, session: slot }],
  }),
);
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
git(home, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.name', 'Fixture');
git(repo, 'config', 'user.email', 'fixture@example.invalid');
git(repo, 'config', 'commit.gpgsign', 'false');
await writeFile(path.join(repo, 'base.txt'), 'base\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'base');
const remote = path.join(home, 'remote.git');
git(home, 'init', '-q', '--bare', remote);
git(repo, 'remote', 'add', 'origin', remote);
git(repo, 'push', '-q', 'origin', 'main');
const commands: Array<{ sha256: string; boundary: string }> = [];
let successor: (() => Promise<void>) | undefined;
const realExec = await import('../../../services/gateway/src/core/exec.js');
const fixtureExec: typeof realExec.execOnSlot = async (_vars, command) => {
  const record = (boundary: string) =>
    commands.push({ sha256: createHash('sha256').update(command).digest('hex'), boundary });
  if (
    /\b(?:tmux|lsof|pgrep|pkill|kill|ps)\b/.test(command) ||
    command.startsWith('identityfile=')
  ) {
    record('session/process transport substituted');
    return { stdout: '', stderr: '', exitCode: command.includes('has-session') ? 1 : 0 };
  }
  assert(
    command.includes(home),
    `Fixture refuses a command outside its root: ${command.slice(0, 100)}`,
  );
  record('private Git/filesystem shell');
  const r = spawnSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
};
mock.module('../../../services/gateway/src/core/exec.js', {
  namedExports: { ...realExec, execOnSlot: fixtureExec },
});
const core = await import('../../../services/gateway/src/core/index.js');
mock.module('../../../services/gateway/src/core/index.js', {
  namedExports: {
    ...core,
    execOnSlot: fixtureExec,
    markSlotStatusIf: async (...args: Parameters<typeof core.markSlotStatusIf>) => {
      if (successor) {
        const replace = successor;
        successor = undefined;
        await replace();
      }
      return core.markSlotStatusIf(...args);
    },
  },
});
const store = await import('../../../services/gateway/src/runs/store.js');
const events: string[] = [];
const rawFleet = await import('../../../services/gateway/src/fleet/state.js');
const fleetSlot = async (): Promise<SlotStatus> => {
  const row = await core.readSlotRow(slot);
  return {
    slot,
    machine: 'local',
    project,
    platform: 'cli',
    branch: git(repo, 'branch', '--show-current'),
    lifecycle: 'ready',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    warm: false,
    phase: null,
    currentRunId: typeof row?.current_run_id === 'string' ? row.current_run_id : null,
    health: { ssh: 'OK', device: '-', devserver: '-', cdp: 'OFF', fixtures: '-' },
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  };
};
mock.module('../../../services/gateway/src/fleet/state.js', {
  namedExports: {
    ...rawFleet,
    loadFleetStatus: async () => ({ slots: [await fleetSlot()] }),
  },
});
const dispatch = await import('../../../services/gateway/src/methods/dispatch.js');
mock.module('../../../services/gateway/src/methods/dispatch.js', {
  namedExports: {
    ...dispatch,
    refreshBranches: async () => {},
    findAffinitySlot: () => null,
    dispatchPreview: async () => ({
      preview: { slotId: slot, runner: 'scripted', model: 'scripted' },
    }),
  },
});
const scaffolding = await import('../../../services/gateway/src/fleet/slot-scaffolding.js');
mock.module('../../../services/gateway/src/fleet/slot-scaffolding.js', {
  namedExports: {
    ...scaffolding,
    archiveSlotScaffolding: async (
      _vars: unknown,
      _project: unknown,
      opts: { destination: string; beforeRemove: () => Promise<void> },
    ) => {
      await opts.beforeRemove();
      events.push('release-old-scaffolding');
      return { roots: 0, directory: opts.destination };
    },
  },
});
const browser = await import('../../../services/gateway/src/run-lifecycle/browser-session-reap.js');
mock.module('../../../services/gateway/src/run-lifecycle/browser-session-reap.js', {
  namedExports: { ...browser, reapSlotBrowserSession: async () => null },
});
const storage = await import('../../../services/gateway/src/fleet/slot-storage-cleanup.js');
mock.module('../../../services/gateway/src/fleet/slot-storage-cleanup.js', {
  namedExports: { ...storage, cleanupSlotStorage: async () => ({ deleted: [], skipped: [] }) },
});
const identity = await import('../../../services/gateway/src/methods/slot/git-identity.js');
mock.module('../../../services/gateway/src/methods/slot/git-identity.js', {
  namedExports: {
    ...identity,
    loadGitIdentity: () => null,
    checkCommitSigning: async () => ({
      name: 'signing',
      status: 'pass',
      detail: 'Excluded fixture capability',
    }),
  },
});
const writer = await import('../../../services/gateway/src/tasks/writer.js');
const { taskInit } = await import('../../../packages/agent-runtime/src/index.js');
mock.module('../../../services/gateway/src/tasks/writer.js', {
  namedExports: {
    ...writer,
    writeTaskFile: (run: Run, opts: Parameters<typeof writer.writeTaskFile>[1]) =>
      writer.writeTaskFile(run, {
        ...opts,
        initializeTask: async (_slot, directory, input) => {
          const result = await taskInit({
            ...input.task,
            template: { sources: [], selection: input.template },
          });
          await cp(input.task.taskDir, directory, { recursive: true });
          return result.executionTemplate;
        },
      }),
  },
});
const prepareFresh: typeof import('../../../services/gateway/src/methods/slot/prepare.js') =
  await import(
    new URL('../../../services/gateway/src/methods/slot/prepare.ts?finished-proof', import.meta.url)
      .href
  );
mock.module('../../../services/gateway/src/methods/slot/prepare.js', {
  namedExports: { ...prepareFresh },
});
const releaseFresh: typeof import('../../../services/gateway/src/methods/slot/release.js') =
  await import(
    new URL('../../../services/gateway/src/methods/slot/release.ts?finished-proof', import.meta.url)
      .href
  );
mock.module('../../../services/gateway/src/methods/slot/release.js', {
  namedExports: { ...releaseFresh },
});
const { executeFindSlotStep } =
  await import('../../../services/gateway/src/run-engine/find-slot-step.js');
const taskSteps: typeof import('../../../services/gateway/src/run-engine/task-steps.js') =
  await import(
    new URL(
      '../../../services/gateway/src/run-engine/task-steps.ts?finished-proof',
      import.meta.url,
    ).href
  );
const { executeWriteTaskStep } = taskSteps;
const policy = await import('../../../services/gateway/src/run-engine/dispatch-policy.js');
const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Private fixture' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const secret = auth.writer.issueCredential(person.id, 'Disposable fixture');
const grant = auth.writer.exchangePersonCredential(secret.secret, {
  deviceName: 'Fixture',
  deviceKind: 'cli',
});
const { createWebSocketServer } = await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const server = createServer(),
  wss = createWebSocketServer(server, auth);
let client: GatewayConnection | undefined;
const results: unknown[] = [];
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 30000,
  }).connect();
  for (const kind of [
    'pushed',
    'merged-deleted',
    'unpublished',
    'successor',
    'completion-refused',
  ] as const) {
    events.length = 0;
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'reset', '--hard', 'origin/main');
    const oldBranch = `fix/old-${kind}`;
    git(repo, 'checkout', '-q', '-b', oldBranch);
    await writeFile(path.join(repo, `${kind}.txt`), `${kind}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', kind);
    if (kind !== 'unpublished') git(repo, 'push', '-q', 'origin', oldBranch);
    if (kind === 'merged-deleted') {
      git(repo, 'checkout', '-q', 'main');
      git(repo, 'merge', '--no-ff', '-qm', 'merge finished task', oldBranch);
      git(repo, 'push', '-q', 'origin', 'main');
      git(repo, 'push', '-q', 'origin', '--delete', oldBranch);
      git(repo, 'fetch', '-q', '--prune', 'origin');
      git(repo, 'checkout', '-q', oldBranch);
    }
    const old = store.createRun({
      project,
      flowType: 'fix-bug',
      mode: 'autonomous',
      lane: 'comparison',
      variant: 'fixture',
      ticketOrPr: 'PROOF-OLD',
      branch: oldBranch,
      slotId: slot,
    });
    store.updateRun(old.id, { status: 'done' });
    const oldTask = path.join(repo, 'temp/tasks/fix/old/TASK.md');
    await mkdir(path.dirname(oldTask), { recursive: true });
    await writeFile(oldTask, 'old task\n');
    await writeFile(
      path.join(home, 'status.json'),
      JSON.stringify({
        slots: [
          {
            slot,
            lifecycle: 'ready',
            agent: 'idle',
            phase: null,
            current_run_id: old.id,
            slot_epoch: 10,
            branch: oldBranch,
            task_file: 'fix/old',
          },
        ],
      }),
    );
    const created: RunCreateResult = await client.call<RunCreateResult>('run.create', {
      project,
      flowType: 'fix-bug',
      mode: 'autonomous',
      lane: 'comparison',
      variant: 'fixture',
      runner: 'scripted',
      scripted: { mode: 'command', commandRef: 'proof' },
      transport: 'tmux',
      ticketOrPr: 'PROOF-137',
      slotId: slot,
      ticketData: {
        source: 'manual',
        title: 'Keep the new task',
        description: 'Private ordering fixture',
        affectedArea: '',
        acceptanceCriteria: ['New task survives prepare'],
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
    });
    store.updateRun(created.run.id, {
      status: 'slot-finding',
      summary: 'Keep the new task',
      engineState: { generation: 0 },
    });
    if (kind === 'successor')
      successor = async () => {
        await core.updateSlotStatus(slot, { current_run_id: 'foreign-successor', slot_epoch: 11 });
      };
    const context: Parameters<typeof executeFindSlotStep>[3] = {
      ...policy,
      broadcastFn: (event) => events.push(event),
      requiresCollisionPrecheck: () => false,
      handleCollisionDecision: async () => 'create-new',
      createEngineDecision: async () => {
        throw new Error('Unexpected fixture decision');
      },
      setRunFlags: () => {},
    };
    if (kind === 'completion-refused') {
      const held = store.createRun({
        project,
        flowType: 'fix-bug',
        mode: 'autonomous',
        ticketOrPr: 'PROOF-HELD',
        slotId: slot,
        branch: oldBranch,
      });
      store.updateRun(held.id, {
        status: 'failed',
        steps: [
          {
            name: 'complete',
            status: 'failed',
            outputs: { gatePrerequisiteRefusal: 'invalid evidence' },
          },
        ],
      });
      await core.updateSlotStatus(slot, { current_run_id: null });
      const { reclaimFinishedSlot } =
        await import('../../../services/gateway/src/run-lifecycle/finished-slot-reclaim.js');
      await assert.rejects(
        reclaimFinishedSlot(slot, store.getRun(created.run.id)!, () => {}),
        /retained by run/,
      );
      await access(oldTask);
      assert.equal(git(repo, 'branch', '--show-current'), oldBranch);
      results.push({ kind, retainedCheckoutPreserved: true });
    } else if (kind === 'unpublished' || kind === 'successor') {
      await assert.rejects(
        executeFindSlotStep(created.run.id, store.getRun(created.run.id)!, 0, context),
        kind === 'unpublished' ? /UNMERGED_WORK/ : /cleanup refused/,
      );
      assert.equal(store.getRun(created.run.id)?.taskFile, null);
      await access(oldTask);
      assert.equal(git(repo, 'branch', '--show-current'), oldBranch);
      results.push({ kind, refusedBeforeClaimOrWrite: true });
    } else {
      const found = await executeFindSlotStep(
        created.run.id,
        store.getRun(created.run.id)!,
        0,
        context,
      );
      assert.equal(found.outputs?.selectedSlot, slot);
      assert.equal(git(repo, 'branch', '--show-current'), 'main');
      assert.equal(store.getRun(created.run.id)?.taskFile, null);
      assert(events.includes('release-old-scaffolding'));
      assert.equal((await core.readSlotRow(slot))?.current_run_id, created.run.id);
      await executeWriteTaskStep(created.run.id, store.getRun(created.run.id)!, {
        broadcastFn: () => {},
        stepPartialIO: new Map(),
      });
      const taskFile = store.getRun(created.run.id)?.taskFile;
      assert(taskFile);
      const before = await readFile(taskFile, 'utf8');
      assert(before.includes('Keep the new task'));
      const workerTask = path.join(
        repo,
        'temp/tasks',
        path.relative(path.join(workspace, 'projects', project, 'tasks'), taskFile),
      );
      assert.equal(await readFile(workerTask, 'utf8'), before);
      const prepared = await prepareFresh.slotPrepare(
        { slotId: slot, prepareProfile: 'fixture', runId: created.run.id },
        () => {},
      );
      assert.equal(prepared.prepared, true);
      assert.equal(await readFile(taskFile, 'utf8'), before);
      assert.equal(await readFile(workerTask, 'utf8'), before);
      const readback: RunGetResult = await client.call<RunGetResult>('run.get', {
        runId: created.run.id,
      });
      assert.equal(readback.run.taskFile, taskFile);
      results.push({
        kind,
        releasedBeforeClaimAndWrite: true,
        newTaskSurvivesPrepare: true,
        taskSha256: createHash('sha256').update(before).digest('hex'),
      });
    }
    for (const run of store.getAllRuns()) {
      store.updateRun(run.id, { status: 'done' });
      await store.deleteRun(run.id);
    }
    await rm(path.join(repo, 'temp'), { recursive: true, force: true });
  }
  const result = {
    status: 'PASS',
    results,
    commands,
    boundary:
      'Authenticated production create/get routes and internal prepare implementation, real slot CAS/store, production FIND_SLOT/WRITE_TASK and guarded release with real private Git. Fleet preview, session/browser/signing transport, scaffolding archive and storage pruning substituted; shared taskInit runs locally. Engine scheduler disabled; no live farm or worker proof.',
    modelTurns: 0,
    liveSlotOperations: [],
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, results }));
} finally {
  client?.close();
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const run of store.getAllRuns()) {
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  }
  await rm(home, { recursive: true, force: true });
  await writeFile(
    path.join(output, 'cleanup.json'),
    JSON.stringify({ home, removed: true }) + '\n',
  );
}
process.exit(0);
