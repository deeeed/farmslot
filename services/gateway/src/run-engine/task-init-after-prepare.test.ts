import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { taskInit } from '@farmslot/agent-runtime';
import type { ExecResult, Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import type { HostedTaskInput } from '../tasks/hosted-task-init.js';

// ADR-068 Amendment 7 regression: a slot left on an older branch failed write-task
// three times because the node producer imported the project's provider from that
// checkout before prepare moved it to the base branch and installed its dependencies.
const executeFile = promisify(execFile);
const root = mkdtempSync(path.join(tmpdir(), 'task-init-after-prepare-'));
const project = 'task-init-fixture';
const slotId = 'task-init-slot';
const repo = path.join(root, 'slot');
const origin = path.join(root, 'origin.git');
const environment = {
  FARMSLOT_ROOT: root,
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'fixture-status.json'),
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  NODE_TEST_CONTEXT: '1',
};
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
for (const dir of ['scripts', 'services/gateway', 'pool', 'home', 'runs'])
  mkdirSync(path.join(root, dir), { recursive: true });
mkdirSync(path.join(root, 'projects', project, 'templates/worker'), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable task-init fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// The provider's declared dependency exists only on main, after the branch the
// previous run left checked out on the slot.
const sentinel = 'scripts/agentic/node_modules/@farmslot/adapter-sdk/package.json';
const author = path.join(root, 'author');
git(root, 'init', '-q', '-b', 'main', author);
git(author, 'config', 'user.name', 'Fixture');
git(author, 'config', 'user.email', 'fixture@example.invalid');
git(author, 'config', 'commit.gpgsign', 'false');
writeFileSync(path.join(author, 'seed.txt'), 'seed\n');
git(author, 'add', '.');
git(author, 'commit', '-qm', 'test: seed');
git(author, 'branch', 'previous-run');
mkdirSync(path.join(author, path.dirname(sentinel)), { recursive: true });
writeFileSync(path.join(author, sentinel), '{"name":"@farmslot/adapter-sdk"}\n');
git(author, 'add', '-f', '.');
git(author, 'commit', '-qm', 'test: install the adapter SDK');
execFileSync('git', ['clone', '-q', '--bare', author, origin]);
execFileSync('git', ['clone', '-q', origin, repo]);
git(repo, 'config', 'commit.gpgsign', 'false');
const main = git(origin, 'rev-parse', 'main');

writeFileSync(
  path.join(root, 'projects', project, 'project.json'),
  JSON.stringify({
    name: project,
    repo_url: 'https://example.invalid/app.git',
    default_branch: 'main',
    task_dir: 'tasks',
    hooks: {},
    execution_templates: { sources: [] },
    recipe: { provider: { module: './scripts/agentic/provider.mjs' }, adapter: 'node' },
    prepare: { default_profile: 'git-only', profiles: { 'git-only': { phases: ['git'] } } },
  }),
);
writeFileSync(
  path.join(root, 'projects', project, 'templates/worker/dev.md'),
  '---\nplatforms: [cli]\n---\n# Worker: dev\n\n- [ ] 1. Implement the change.\n- [ ] 2. Validate it.\n',
);
writeFileSync(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'fixture',
    host: 'localhost',
    project,
    platform: 'cli',
    slots: [{ id: slotId, repo, session: slotId, resources: {} }],
  }),
);
writeFileSync(
  environment.FARMSLOT_TEST_STATUS_FILE,
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine: 'fixture',
        project,
        platform: 'cli',
        branch: 'main',
        lifecycle: 'ready',
        agent: 'idle',
        current_run_id: null,
        enabled: true,
        health: { ssh: 'LOCAL' },
      },
    ],
  }),
);

// Git runs for real; tmux never does (prepare only asks whether a session exists).
async function slotExec(vars: SlotVars, command: string): Promise<ExecResult> {
  if (command.includes('TMUX_BIN') || /\btmux\b/.test(command))
    return { exitCode: 1, stdout: '', stderr: 'fixture has no tmux server' };
  try {
    const result = await executeFile('bash', ['-c', command], {
      cwd: vars.remoteRepo,
      timeout: 10_000,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string; code?: number };
    if (typeof result.code !== 'number') throw error;
    return { exitCode: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}
const realExec = await import('../core/exec.js');
mock.module('../core/exec.js', { namedExports: { ...realExec, execOnSlot: slotExec } });
const realCore = await import('../core/index.js');
mock.module('../core/index.js', { namedExports: { ...realCore, execOnSlot: slotExec } });

// The node producer: refuses like production unless the checkout has the dependency,
// otherwise runs the shared producer in the slot task dir and mirrors it with a receipt.
const initialized: HostedTaskInput[] = [];
const verified: string[] = [];
let refuseNextInit = false;
const hosted = await import('../tasks/hosted-task-init.js');
mock.module('../tasks/hosted-task-init.js', {
  namedExports: {
    ...hosted,
    initializeHostedTaskOnSlot: async (
      slot: SlotVars,
      gatewayTaskDir: string,
      input: HostedTaskInput,
    ) => {
      initialized.push(input);
      if (!existsSync(path.join(slot.remoteRepo, sentinel)))
        throw new Error(
          `Node task initialization refused: Declared task dependency @farmslot/adapter-sdk is not installed for ${slot.remoteRepo}/scripts/agentic`,
        );
      if (refuseNextInit) {
        refuseNextInit = false;
        throw new Error('Node task initialization refused: injected node restart');
      }
      const result = await taskInit({
        ...input.task,
        template: { sources: [], selection: input.template },
      });
      writeFileSync(path.join(input.task.taskDir, 'artifacts/harness-provenance.json'), '{}\n');
      await cp(input.task.taskDir, gatewayTaskDir, { recursive: true });
      return result.executionTemplate;
    },
    verifyHostedTaskOnSlot: async (_slot: SlotVars, taskDir: string) => {
      verified.push(taskDir);
    },
  },
});
const stop = new Error('Fixture stops before worker launch');
const staged: Run['engineState'][] = [];
const inherited = await import('../run-completion/inherited-acceptance.js');
mock.module('../run-completion/inherited-acceptance.js', {
  namedExports: {
    ...inherited,
    stageInheritedAcceptance: async (run: Run) => {
      staged.push(run.engineState);
      throw stop;
    },
  },
});

const { getOrchestratorTaskRoot } = await import('../core/config.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { executeWriteTaskStep } = await import('./task-steps.js');
const { executeDispatchStep, executePrepareStep } = await import('./dispatch-lifecycle-steps.js');

after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const budget = { timeout: 120_000 };

function slotOn(branch: 'previous-run' | 'main') {
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'checkout', '-q', '-B', branch, `origin/${branch}`);
  assert.equal(existsSync(path.join(repo, sentinel)), branch === 'main');
}

function devRun(t: TestContext, ticket: string, taskFile?: string) {
  const run = createRun({
    flowType: 'dev',
    project,
    ticketOrPr: ticket,
    slotId,
    mode: 'autonomous',
    branch: `feat/${ticket.toLowerCase()}`,
    prepareProfile: 'git-only',
    ...(taskFile ? { taskFile } : {}),
    ticketData: {
      source: 'manual',
      title: `Task ${ticket}`,
      description: 'Initialize the task after prepare',
      acceptanceCriteria: ['The task initializes on the prepared checkout'],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });
  updateRun(run.id, { summary: `Task ${ticket}` });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  return run;
}

const writeTask = (runId: string) =>
  executeWriteTaskStep(runId, getRun(runId)!, {
    broadcastFn: () => undefined,
    stepPartialIO: new Map(),
  });
const prepare = (runId: string, skipPrepare = false) =>
  executePrepareStep(runId, {
    activeMonitors: new Map(),
    broadcastFn: () => undefined,
    getRunFlags: () => (skipPrepare ? { skipPrepare: true } : undefined),
    normalizeEvalReplayForTaskWrite: async (_id, run) => run,
    stepPartialIO: new Map(),
  });
const workerTaskDir = (taskFile: string) =>
  path.join(
    repo,
    'tasks',
    path.basename(path.dirname(path.dirname(taskFile))),
    path.basename(path.dirname(taskFile)),
  );

function assertInitializedOnMain(runId: string) {
  const run = getRun(runId)!;
  const taskDir = path.dirname(run.taskFile!);
  assert.equal(git(repo, 'merge-base', '--is-ancestor', main, 'HEAD'), '');
  assert.deepEqual(run.engineState?.taskInit, { taskFile: run.taskFile, status: 'initialized' });
  assert.equal(existsSync(path.join(taskDir, '.task-init.json')), false);
  assert.ok(existsSync(path.join(taskDir, 'mark')));
  assert.equal(
    readFileSync(path.join(workerTaskDir(run.taskFile!), 'TASK.md'), 'utf8'),
    readFileSync(run.taskFile!, 'utf8'),
  );
}

test('write-task defers initialization until prepare left the slot on main', budget, async (t) => {
  slotOn('previous-run');
  const run = devRun(t, 'TI-1');
  const before = initialized.length;

  const written = await writeTask(run.id);

  assert.equal(initialized.length, before, 'write-task never runs the node producer');
  const taskFile = getRun(run.id)!.taskFile!;
  assert.equal(written.outputs?.taskFile, taskFile);
  assert.deepEqual(getRun(run.id)!.engineState?.taskInit, { taskFile, status: 'pending' });
  assert.equal(existsSync(taskFile), false, 'nothing exists before the producer runs');
  assert.equal(existsSync(workerTaskDir(taskFile)), false, 'nothing is copied to the slot');

  await prepare(run.id);

  assert.equal(initialized.length, before + 1);
  assert.equal(initialized.at(-1)!.binding, 'project');
  assertInitializedOnMain(run.id);
  assert.ok(getRun(run.id)!.executionTemplate?.id);
  assert.deepEqual(
    getRun(run.id)!.templateProvenance?.executionTemplate,
    getRun(run.id)!.executionTemplate,
  );
});

test('an authored run create --task initializes after prepare', budget, async (t) => {
  slotOn('previous-run');
  const taskFile = path.join(getOrchestratorTaskRoot(project), 'dev/authored-ti-2/TASK.md');
  mkdirSync(path.dirname(taskFile), { recursive: true });
  writeFileSync(taskFile, '# Authored task\n\n- [ ] 1. Do the authored work.\n');
  const run = devRun(t, 'TI-2', taskFile);
  const before = initialized.length;

  await writeTask(run.id);
  assert.equal(initialized.length, before);
  assert.deepEqual(getRun(run.id)!.engineState?.taskInit, { taskFile, status: 'pending' });

  await prepare(run.id);

  assert.equal(initialized.length, before + 1);
  assert.equal(
    initialized.at(-1)!.task.authored?.taskMarkdown,
    '# Authored task\n\n- [ ] 1. Do the authored work.\n',
  );
  assertInitializedOnMain(run.id);
});

test('a prepare replay after initialization only verifies the task', budget, async (t) => {
  slotOn('previous-run');
  const run = devRun(t, 'TI-3');
  await writeTask(run.id);
  await prepare(run.id);
  const taskFile = getRun(run.id)!.taskFile!;
  const bytes = () =>
    [
      taskFile,
      path.join(path.dirname(taskFile), 'mark'),
      path.join(workerTaskDir(taskFile), 'TASK.md'),
    ].map((file) => readFileSync(file, 'utf8'));
  const first = bytes();
  const inits = initialized.length;
  const verifies = verified.length;

  await prepare(run.id);

  assert.equal(initialized.length, inits, 'no second producer run');
  assert.deepEqual(verified.slice(verifies), [workerTaskDir(taskFile)]);
  assert.deepEqual(bytes(), first);
  assertInitializedOnMain(run.id);
});

test('a refused initialization retries the same frozen input', budget, async (t) => {
  slotOn('previous-run');
  const run = devRun(t, 'TI-4');
  await writeTask(run.id);
  const taskFile = getRun(run.id)!.taskFile!;
  const frozen = readFileSync(path.join(path.dirname(taskFile), '.task-init.json'), 'utf8');
  refuseNextInit = true;

  await assert.rejects(prepare(run.id), /injected node restart/);
  assert.deepEqual(getRun(run.id)!.engineState?.taskInit, { taskFile, status: 'pending' });
  assert.equal(readFileSync(path.join(path.dirname(taskFile), '.task-init.json'), 'utf8'), frozen);

  await prepare(run.id);

  assert.deepEqual(initialized.at(-1), initialized.at(-2));
  assert.deepEqual(initialized.at(-1), JSON.parse(frozen).input);
  assertInitializedOnMain(run.id);
});

test(
  'dispatch initializes a task prepare left pending before staging parent proof',
  budget,
  async (t) => {
    // Restart recovery marked prepare done on a slot it had already moved to main.
    slotOn('main');
    const run = devRun(t, 'TI-5');
    await writeTask(run.id);
    updateRun(run.id, { parentRunId: 'fixture-parent' });
    const before = initialized.length;

    await assert.rejects(
      executeDispatchStep(run.id, {
        stepPartialIO: new Map(),
        blockedRunError: (message) => new Error(message),
      }),
      (error) => error === stop,
    );

    assert.equal(initialized.length, before + 1);
    assert.equal(staged.at(-1)?.taskInit?.status, 'initialized');
    assertInitializedOnMain(run.id);
  },
);

test('skip-prepare still initializes the task once', budget, async (t) => {
  slotOn('main');
  const run = devRun(t, 'TI-6');
  await writeTask(run.id);
  const before = initialized.length;

  const result = await prepare(run.id, true);

  assert.equal(result.outputs?.skipped, true);
  assert.equal(initialized.length, before + 1);
  assertInitializedOnMain(run.id);
});
