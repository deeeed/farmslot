// Gate-action proof of c616be16: a pr-complete run P waits in the real CI watch on a merge
// conflict; the operator resolves that decision through the authenticated gateway RPC that
// `farmslot run gate --action` sends; the real CI-watch step chains update-branch run C; P's real
// done transition releases its slot while C is already active, which holds the slot for C; C's
// real warm handoff then sends its prompt into P's worker and claims the slot.
//
// Real: authenticated gateway socket and `run.resolveDecision`, the run engine (CI-watch step,
// CI monitor with the GitHub client pointed at a local GitHub stand-in, chaining, the done
// transition and slot release), C's dispatch step and warm handoff, the run store and the slot
// status file. Scripted: P's publication prerequisites (no real package or PR), C's task text
// (write-task), and the runner layer (worker liveness, retained pane lookup, the prompt send).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = fileURLToPath(new URL('../../../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'warm-gate-proof-'));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/warm-handoff-gate');
const slotId = 'warm-gate-slot';
const repo = path.join(root, 'repo');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  TMUX_TMPDIR: path.join(root, 'tmux'),
});
delete process.env.TMUX;
const tmux = (...args: string[]) =>
  execFileSync('tmux', args, { env: process.env, encoding: 'utf8' }).trim();
for (const dir of ['pool', 'projects/proof', 'repo', 'tmux', 'tasks'])
  await mkdir(path.join(root, dir), { recursive: true });
await mkdir(output, { recursive: true });
// The slot checkout: P's PR branch, as the retained delivery records its inherited head.
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
git('init', '-q', '-b', 'fixture-branch');
git(
  '-c',
  'user.name=Proof',
  '-c',
  'user.email=proof@example.invalid',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-q',
  '--allow-empty',
  '-m',
  'test: fixture PR head',
);
git('update-ref', 'refs/remotes/origin/fixture-branch', 'HEAD');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
await writeFile(
  path.join(root, 'pool/proof.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'proof',
    platform: 'cli',
    slots: [{ id: slotId, repo, session: 'proof' }],
  }),
);
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({
    name: 'proof',
    default_branch: 'main',
    ci: { repo: 'owner/repo' },
    // The operator decides, as for 12afdc85: the conflict is a gate, not an auto-dispatch.
    ci_watch: { auto_dispatch: { merge_conflicts: false } },
    hooks: {},
  }),
);

// GitHub, as the gateway's own client reaches it: one open PR that conflicts with its base.
const load = (file: string) => import(pathToFileURL(path.join(code, file)).href);
const { startGitHubFixture } = await load(
  'services/gateway/src/integrations/github-test-fixtures.ts',
);
const pullRequest = {
  id: 'PR_77',
  number: 77,
  state: 'OPEN',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  title: 'Fixture PR',
  reviewDecision: null,
  headRefName: 'fixture-branch',
  headRefOid: 'a'.repeat(40),
  baseRefName: 'main',
  isDraft: false,
  url: 'https://github.com/owner/repo/pull/77',
  author: { login: 'fixture' },
  commits: { totalCount: 1, nodes: [] },
  statusCheckRollup: null,
  reviews: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  latestReviews: { nodes: [] },
  reviewThreads: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  comments: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  labels: { nodes: [] },
  files: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
};
const restPull = {
  number: 77,
  state: 'open',
  title: pullRequest.title,
  body: '',
  html_url: pullRequest.url,
  user: { login: 'fixture' },
  draft: false,
  mergeable: false,
  mergeable_state: 'dirty',
  head: { ref: 'fixture-branch', sha: pullRequest.headRefOid, repo: { full_name: 'owner/repo' } },
  base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'owner/repo' } },
};
const github = await startGitHubFixture((request: { path: string }) =>
  request.path.endsWith('/graphql')
    ? {
        body: {
          data: {
            repository: { pullRequest, object: null },
            rateLimit: { cost: 1, remaining: 4999, resetAt: '2099-01-01T00:00:00Z' },
          },
        },
      }
    : /\/pulls\/77$/.test(request.path)
      ? { body: restPull }
      : { body: [] },
);
process.env.FARMSLOT_GITHUB_API_URL = github.origin;
process.env.FARMSLOT_GITHUB_FIXTURE_TOKEN = 'fixture';

const sourceFile = (file: string) =>
  pathToFileURL(path.join(code, 'services/gateway/src', file)).href;
// The originals load under their own URL, so the module the gateway imports is the stub even
// when something loaded the original first.
const stub = async (file: string, exports: Record<string, unknown>) => {
  const real = await import(`${sourceFile(file)}?original`);
  mock.module(sourceFile(file), { namedExports: { ...real, ...exports } });
};
// C's task text is not under test (it needs a pack's execution-template catalog): write the
// task file the dispatch step reads. Only the orchestrator imports this module, so it is mocked
// whole, before anything loads it.
const unused = (name: string) => () => {
  throw new Error(`${name} is not part of this proof`);
};
mock.module(sourceFile('run-engine/task-steps.ts'), {
  namedExports: {
    executeGradeStep: unused('grade'),
    mergeInitialContextIntoTicketData: unused('mergeInitialContextIntoTicketData'),
    prepareProfileDecisionLabel: unused('prepareProfileDecisionLabel'),
    executeWriteTaskStep: async (runId: string) => {
      const taskFile = path.join(root, 'tasks', 'update-branch', runId.slice(0, 8), 'TASK.md');
      await mkdir(path.dirname(taskFile), { recursive: true });
      await writeFile(taskFile, '# Update the branch\n');
      (await load('services/gateway/src/runs/store.ts')).updateRun(runId, { taskFile });
      return { inputs: {}, outputs: { taskFile } };
    },
  },
});
// Stubs go in leaf-first, before anything imports the modules that use them.
// The scripted task has no hosted-task receipt to verify.
await stub('tasks/hosted-task-init.ts', { verifyHostedTaskOnSlot: async () => undefined });
// The runner layer: the retained worker's pane lookup and the prompt send. Its liveness is real:
// a process named claude in a tmux pane on a private server.
const sends: Array<{ runId: unknown; owner: unknown }> = [];
await stub('runners/session-process.ts', {
  resolveRetainedRunnerPane: async () => ({ target: 'proof:dev.0', window: 'dev', pane: '0' }),
  resolvePersistedRunnerSessionBinding: () => ({ ok: true, binding: null }),
});
await stub('runners/prompt-delivery-evidence.ts', {
  readLaunchAckSignalSnapshot: async () => null,
});
await stub('runners/worker-prompt.ts', { resolveWorkerNudgePrompt: async () => 'fixture task' });
await stub('runners/session-reactivation.ts', {
  deliverPromptWithRetainedFallback: async () => {
    const row = await (await load('services/gateway/src/core/state.ts')).readSlotRow(slotId);
    sends.push({ runId: row?.current_run_id ?? null, owner: row?.cleanup_run_id ?? null });
    return { delivered: true };
  },
});
// P has no real publication package or PR: its prerequisites pass as published.
await stub('run-engine/publication-finalization.ts', { assertPublicationFinalization: () => {} });

const store = await load('services/gateway/src/runs/store.ts');
const state = await load('services/gateway/src/core/state.ts');
const engine = await load('services/gateway/src/run-engine/orchestrator.ts');
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Warm gate proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const credential = auth.writer.issueCredential(person.id, 'Disposable proof');
const grant = await auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Proof',
  deviceKind: 'cli',
});
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const server = createServer();
const wss = createWebSocketServer(server, auth);
const log = (line: string) => console.log(`[proof] ${line}`);
let client;
const until = async <T,>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  what: string,
) => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 30000,
  }).connect();

  // P's worker conversation: the child's usage budget pins its baseline here.
  const transcript = path.join(root, 'parent-session.jsonl');
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'fixture-1',
      timestamp: new Date().toISOString(),
      message: { id: 'msg_fixture', usage: { input_tokens: 10, output_tokens: 5 } },
    })}\n`,
  );
  const { primaryRoleForFlow } = await load('packages/protocol/src/index.ts');
  // P: a pr-complete run at its CI watch, its earlier steps done, its worker warm on the slot.
  const parent = store.createRun(
    {
      project: 'proof',
      flowType: 'pr-complete',
      mode: 'autonomous',
      transport: 'tmux',
      runner: 'claude',
      model: 'opus',
      ticketOrPr: 'owner/repo#77',
      slotId,
      branch: 'fixture-branch',
    },
    { createdByPrincipalId: person.id, nativeOwnerPrincipalId: person.id },
  );
  store.updateRun(parent.id, {
    status: 'ci-watching',
    prNumber: 77,
    steps: parent.steps.map((step: { name: string }) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'pending' }
        : { ...step, status: 'done', completedAt: new Date().toISOString() },
    ),
    metrics: { ...parent.metrics, runner: 'claude', model: 'opus' },
    agentContexts: [
      {
        id: primaryRoleForFlow('pr-complete'),
        runId: parent.id,
        slotId,
        role: primaryRoleForFlow('pr-complete'),
        label: 'Worker',
        status: 'idle',
        runner: 'claude',
        model: 'opus',
        modelQuestions: 'off',
        runnerSessionId: 'fixture-session',
        runnerSessionPath: transcript,
      },
    ],
  });
  await writeFile(
    state.statusFile,
    JSON.stringify({
      slots: [
        {
          slot: slotId,
          lifecycle: 'held',
          phase: 'ci-watch',
          agent: 'idle',
          slot_epoch: 4,
          current_run_id: parent.id,
          runner: 'claude',
          model: 'opus',
          current_flow_type: 'pr-complete',
        },
      ],
    }),
  );
  // P's worker: a long-lived process named claude in the slot's tmux session, on a server whose
  // socket is under this proof's TMUX_TMPDIR, so only this proof's panes are ever listed.
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  // A copied system binary loses its signature; a freshly linked one is signed ad hoc.
  await writeFile(
    path.join(root, 'claude.c'),
    '#include <unistd.h>\nint main(void){sleep(3600);return 0;}\n',
  );
  execFileSync('cc', ['-o', path.join(bin, 'claude'), path.join(root, 'claude.c')]);
  tmux('new-session', '-d', '-s', 'proof', '-n', 'worker', '-c', repo, path.join(bin, 'claude'));
  const workerPid = tmux('display-message', '-p', '-t', 'proof:worker', '#{pane_pid}');
  log(`parent worker: pid ${workerPid} in proof:worker`);
  void engine.startRun(parent.id).catch((error: Error) => log(`parent engine: ${error.message}`));
  const decision = await until(
    () => store.getRun(parent.id)?.decisions?.find((d: { resolvedAt?: string }) => !d.resolvedAt),
    Boolean,
    "the CI watch's merge-conflict decision",
  );
  log(
    `parent CI decision: ${decision.type} [${decision.actions.map((a: { id: string }) => a.id).join(', ')}]`,
  );

  // The operator's gate action, as `farmslot run gate --action dispatch-update-branch` sends it.
  await client.call('run.resolveDecision', {
    runId: parent.id,
    decisionId: decision.id,
    actionId: 'dispatch-update-branch',
  });
  const child = await until(
    () => store.getAllRuns().find((run: { parentRunId?: string }) => run.parentRunId === parent.id),
    Boolean,
    'the chained update-branch run',
  );
  log(`chained child: ${child.flowType} ${child.id.slice(0, 8)}`);
  const heldFor = await until(
    () => state.readSlotRow(slotId),
    (row: Record<string, unknown> | null) => row?.lifecycle === 'held' && row.phase === 'occupied',
    "the parent's hold",
  ).catch(() => null);
  if (heldFor) log(`slot after parent done: held/occupied, reason="${heldFor.held_reason}"`);
  const settled = await until(
    () => store.getRun(child.id),
    (run: { status: string; steps: Array<{ name: string; status: string }> }) =>
      ['monitoring', 'failed', 'blocked', 'done', 'cancelled'].includes(run.status) ||
      run.steps.some(
        (step) => step.name === 'dispatch' && ['done', 'failed'].includes(step.status),
      ),
    "the child's dispatch",
  );
  const dispatch = settled.steps.find((step: { name: string }) => step.name === 'dispatch');
  const row = await state.readSlotRow(slotId);
  log(`parent status: ${store.getRun(parent.id)?.status}`);
  log(`child dispatch: ${dispatch?.status}${dispatch?.detail ? ` — ${dispatch.detail}` : ''}`);
  log(
    `prompts sent: ${sends.length}${sends[0] ? ` (slot at the send: owner=${sends[0].runId}, cleanup=${sends[0].owner === parent.id ? 'parent' : sends[0].owner})` : ''}`,
  );
  log(
    `slot after child: lifecycle=${row?.lifecycle} owner=${row?.current_run_id === child.id ? 'child' : row?.current_run_id} held_reason=${row?.held_reason ?? null}`,
  );
  const result = {
    pass: dispatch?.status === 'done' && row?.current_run_id === child.id,
    heldBeforeClaim: Boolean(heldFor),
    sends: sends.length,
    childDispatch: dispatch?.status,
    detail: dispatch?.detail ?? null,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  assert.equal(result.pass, true, 'the child claims the slot after its prompt');
} finally {
  client?.close();
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const run of store.getAllRuns()) {
    engine.cancelRunEngine(run.id);
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  }
  await github.close();
  // Only this proof's private tmux server (its socket lives under TMUX_TMPDIR).
  try {
    tmux('kill-server');
  } catch (error) {
    // A server that never started, or already exited, leaves nothing to stop.
    if (!String(error).includes('no server running')) console.warn(String(error));
  }
  await rm(root, { recursive: true, force: true });
}
process.exit(0);
