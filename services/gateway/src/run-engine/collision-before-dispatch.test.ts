import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { AgentContext, NativeWorkerSessionBinding, Run, RunStep } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'collision-before-dispatch-'));
const project = 'collision-proof';
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
await mkdir(path.join(root, 'pool'), { recursive: true });
await mkdir(path.join(root, 'projects', project), { recursive: true });
await writeFile(
  path.join(root, 'projects', project, 'project.json'),
  JSON.stringify({ name: project, task_dir: 'tasks', hooks: {} }),
);
await import('../runtime/mock-pty.test-support.js');
const { archiveRun, createRun, getRun, updateRun } = await import('../runs/store.js');
const { precheckTaskDirCollision, RUNTIME_CAPABILITY_CATALOG_INPUT } =
  await import('../tasks/writer.js');
const { getOrchestratorTaskRoot } = await import('../core/index.js');
const { flowDir } = await import('../intelligence/engine.js');
const { handleCollisionDecision, resolveEngineDecision } = await import('./engine-decisions.js');
const { deleteTestRunIfPresent } = await import('./test-fixtures.js');

const created: string[] = [];
after(async () => {
  for (const id of created) await deleteTestRunIfPresent(id);
  await rm(root, { recursive: true, force: true });
});
let dirCount = 0;

/** A task dir as writeTaskFile leaves it right after mkdir, with the given owner stamp. */
async function taskDir(ticket: string, stamp: string | null): Promise<void> {
  const dir = path.join(
    getOrchestratorTaskRoot(project),
    flowDir('dev'),
    `${ticket.toLowerCase()}-1030-23${String(dirCount++).padStart(4, '0')}`,
  );
  await mkdir(path.join(dir, 'inputs'), { recursive: true });
  if (stamp !== null) await writeFile(path.join(dir, RUNTIME_CAPABILITY_CATALOG_INPUT), stamp);
}

type AttemptOptions = {
  taskFile?: string;
  dispatchStartedAt?: string;
  stamp?: 'owner' | 'none' | 'truncated';
  project?: string;
  fields?: (run: Run) => Partial<Run>;
};

/** An earlier attempt with the given outcome and step statuses, and the task dir it wrote. */
async function attempt(
  ticket: string,
  status: Run['status'],
  stepStatus: Record<string, RunStep['status']>,
  options: AttemptOptions = {},
): Promise<Run> {
  const run = createRun({
    flowType: 'dev',
    project: options.project ?? project,
    ticketOrPr: ticket,
  });
  created.push(run.id);
  updateRun(run.id, {
    ...options.fields?.(run),
    status,
    taskFile: options.taskFile ?? null,
    steps: run.steps.map((step) => ({
      ...step,
      status: stepStatus[step.name] ?? step.status,
      ...(step.name === 'dispatch' && options.dispatchStartedAt
        ? { startedAt: options.dispatchStartedAt }
        : {}),
    })),
  });
  const stamp = JSON.stringify({ version: 1, ownerRunId: run.id });
  await taskDir(
    ticket,
    { owner: stamp, none: null, truncated: stamp.slice(0, 20) }[options.stamp ?? 'owner'],
  );
  return getRun(run.id)!;
}

const nativeBinding: NativeWorkerSessionBinding = {
  sessionId: 'native-session',
  executionNodeId: 'fixture-node',
  ownerPrincipalId: 'fixture-person',
  leaseId: 'fixture-lease',
  commandId: 'fixture-command',
};
const workerContext = (run: Run, launch: Partial<AgentContext>): AgentContext => ({
  id: 'dev',
  role: 'dev',
  label: 'Dev',
  status: 'failed',
  slotId: null,
  runId: run.id,
  ...launch,
});

/** Records a dispatch leaves on the run; replay from prepare resets the dispatch step only. */
const dispatchRecords: Array<[string, string, (run: Run) => Partial<Run>]> = [
  [
    'KEEP-TASK-EXECUTION',
    'its task execution',
    (run) => ({
      engineState: {
        taskExecution: { taskFile: 'tasks/feat/keep/TASK.md', startedAt: run.createdAt },
      },
    }),
  ],
  ['KEEP-WORKTREE-HEAD', 'its worktree head', () => ({ worktreeHeadAtDispatch: 'a'.repeat(40) })],
  [
    'KEEP-REVIEW-DISPATCH',
    "a slot-free review's dispatch generation",
    () => ({ engineState: { workspaceReviewDispatchGeneration: 1 } }),
  ],
  [
    'KEEP-RUNNER-SESSION',
    'its runner session',
    (run) => ({ metrics: { ...run.metrics, runnerSessionId: 'runner-session' } }),
  ],
  [
    'KEEP-LAUNCHED-WORKER',
    'a launched worker context',
    (run) => ({ agentContexts: [workerContext(run, { startedAt: run.createdAt })] }),
  ],
  [
    'KEEP-NATIVE-RESTART',
    "a native worker's session history",
    (run) => ({ agentContexts: [workerContext(run, { nativeSessionHistory: [nativeBinding] })] }),
  ],
];

for (const [ticket, record, fields] of dispatchRecords) {
  test(`an attempt replayed from prepare after its dispatch keeps the decision: ${record}`, async () => {
    await attempt(
      ticket,
      'failed',
      { 'write-task': 'done', prepare: 'failed', dispatch: 'pending' },
      { fields },
    );
    const { current, choice } = await redispatch(ticket);
    const decision = await pendingCollision(current.id);
    assert.equal(resolveEngineDecision(decision.id, 'abort'), true);
    await assert.rejects(choice, /Aborted: task dir collision/);
  });
}

test('a dir the redispatching run wrote itself keeps the collision decision', async () => {
  const current = createRun({ flowType: 'dev', project, ticketOrPr: 'KEEP-SELF' });
  created.push(current.id);
  await taskDir('KEEP-SELF', JSON.stringify({ version: 1, ownerRunId: current.id }));
  const { existingDirs, ticketSlug } = await precheckTaskDirCollision(current);
  const choice = handleCollisionDecision(current.id, current, existingDirs, ticketSlug);
  const decision = await pendingCollision(current.id);
  assert.equal(resolveEngineDecision(decision.id, 'abort'), true);
  await assert.rejects(choice, /Aborted: task dir collision/);
});

async function redispatch(ticket: string) {
  const current = createRun({ flowType: 'dev', project, ticketOrPr: ticket });
  created.push(current.id);
  const { existingDirs, ticketSlug } = await precheckTaskDirCollision(current);
  assert.ok(existingDirs.length > 0, 'the earlier attempt left a colliding task dir');
  return {
    current,
    choice: handleCollisionDecision(current.id, current, existingDirs, ticketSlug),
  };
}

async function pendingCollision(runId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const decision = getRun(runId)?.decisions.find((item) => item.type === 'engine_collision');
    if (decision) return decision;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('The collision never asked the operator');
}

// A regression would wait on the operator forever; fail fast instead.
test(
  'a redispatch after attempts that ended before dispatch takes a new task dir without asking',
  { timeout: 5_000 },
  async () => {
    // Refused during write-task: the dir exists but the run never recorded its task file.
    await attempt('MANUAL-1', 'failed', {
      'write-task': 'failed',
      prepare: 'skipped',
      dispatch: 'skipped',
    });
    // Wrote its task, failed at prepare and was archived, as operators do with failed runs.
    const archived = await attempt(
      'MANUAL-1',
      'failed',
      { 'write-task': 'done', prepare: 'failed', dispatch: 'skipped' },
      { taskFile: 'tasks/feat/manual-1/TASK.md' },
    );
    assert.equal(await archiveRun(archived.id), true);
    await attempt('MANUAL-1', 'cancelled', { dispatch: 'pending' });

    const { current, choice } = await redispatch('MANUAL-1');
    assert.equal(await choice, 'create-new');
    assert.deepEqual(getRun(current.id)!.decisions, [], 'nothing waited on the operator');
  },
);

for (const [ticket, name, setup] of [
  [
    'KEEP-DISPATCHED',
    'an earlier attempt that reached dispatch',
    (ticket: string) =>
      attempt(
        ticket,
        'failed',
        { 'write-task': 'done', prepare: 'done', dispatch: 'done' },
        { dispatchStartedAt: new Date().toISOString() },
      ),
  ],
  [
    'KEEP-LIVE',
    'an earlier attempt that is still live',
    (ticket: string) => attempt(ticket, 'preparing', {}),
  ],
  [
    'KEEP-OTHER-PROJECT',
    "a stamp naming another project's run",
    (ticket: string) =>
      attempt(
        ticket,
        'failed',
        { 'write-task': 'failed', dispatch: 'skipped' },
        { project: 'other' },
      ),
  ],
  [
    'KEEP-UNSTAMPED',
    'a task dir with no owner stamp',
    (ticket: string) =>
      attempt(ticket, 'failed', { 'write-task': 'failed', dispatch: 'skipped' }, { stamp: 'none' }),
  ],
  [
    'KEEP-TRUNCATED',
    'a task dir whose owner stamp was cut short',
    (ticket: string) =>
      attempt(
        ticket,
        'failed',
        { 'write-task': 'failed', dispatch: 'skipped' },
        { stamp: 'truncated' },
      ),
  ],
] as const) {
  test(`${name} keeps the collision decision`, async () => {
    await setup(ticket);
    const { current, choice } = await redispatch(ticket);
    const decision = await pendingCollision(current.id);
    assert.equal(decision.resolvedAt, undefined);
    assert.equal(resolveEngineDecision(decision.id, 'abort'), true);
    await assert.rejects(choice, /Aborted: task dir collision/);
  });
}
