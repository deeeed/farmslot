// Manual authenticated monitor proof. Native registration and tmux transport are
// fixtures; the adapter reads real structured files and the monitor/store/RPC run.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import type { MonitorResult } from '../../../services/gateway/src/run-engine/run-monitor.js';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = fileURLToPath(new URL('../../../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'worker-question-proof-'));
const permission = process.env.FARMSLOT_PROOF_PERMISSION === '1';
let permissionOpen = permission;
const output = path.resolve(
  process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/worker-question',
  permission ? 'permission' : '.',
);
const sessionId = 'fixture-worker';
const transcript = path.join(root, `${sessionId}.jsonl`);
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
for (const directory of ['pool', 'projects/proof', 'repo/tasks/proof'])
  await mkdir(path.join(root, directory), { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(
  path.join(root, 'pool/proof.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'proof',
    platform: 'cli',
    slots: [{ id: 'question-slot', repo: path.join(root, 'repo'), session: 'question-slot' }],
  }),
);
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({
    name: 'proof',
    hooks: {},
    monitoring: {
      poll_interval_min: 10 / 60_000,
      stuck_timeout_min: 20,
      total_timeout_min: 90,
      max_nudges: 0,
    },
  }),
);
await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: [] }));
const question = {
  type: 'assistant',
  sessionId,
  isSidechain: false,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'ask-1',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which network should the proof use?',
              options: [{ label: 'Testnet', description: 'Use the fixture' }, { label: 'Mainnet' }],
            },
          ],
        },
      },
    ],
  },
};
const answer = {
  type: 'user',
  sessionId,
  isSidechain: false,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'Testnet' }],
  },
};
const writeTranscript = (rows: unknown[]) =>
  writeFile(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
const bash = {
  ...question,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'pwd' },
      },
    ],
  },
};
await writeTranscript([permission ? bash : question]);
const load = (file: string) => import(pathToFileURL(path.join(code, file)).href);
const execution = await load('services/gateway/src/core/exec.ts');
let probes = 0;
let paneCaptures = 0;
mock.module(pathToFileURL(path.join(code, 'services/gateway/src/core/exec.ts')).href, {
  namedExports: {
    ...execution,
    execOnSlot: async (vars: unknown, command: string, options: unknown) => {
      if (command.includes('capture-pane')) {
        paneCaptures++;
        return {
          // Reuse the existing worker-question.test.ts permission fixture; no new renderer matching.
          stdout: permissionOpen
            ? 'Apply the patch?\nDo you want to continue? [y/n]'
            : 'No question menu in this fixture capture',
          stderr: '',
          exitCode: 0,
        };
      }
      if (command.includes('tmux')) return { stdout: '', stderr: '', exitCode: 0 };
      if (command.includes('pending = {}')) probes++;
      return execution.execOnSlot(vars, command, options);
    },
  },
});
const processReader = await load('services/gateway/src/runners/claude-process-observability.ts');
mock.module(
  pathToFileURL(path.join(code, 'services/gateway/src/runners/claude-process-observability.ts'))
    .href,
  {
    namedExports: {
      ...processReader,
      readClaudeProcessState: async () => ({
        sessionId,
        sessionPath: transcript,
        processPid: 'fixture-pid',
        status: 'busy',
        observedAt: Date.now(),
      }),
    },
  },
);
const store = await load('services/gateway/src/runs/store.ts');
const { monitorRun, resolveMonitorDecision } = await load(
  'services/gateway/src/run-engine/run-monitor.ts',
);
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Worker question proof' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
const credential = auth.writer.issueCredential(person.id, 'Disposable proof');
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Proof',
  deviceKind: 'cli',
});
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const server = createServer();
const wss = createWebSocketServer(server, auth);
const controller = new AbortController();
let monitoring: Promise<MonitorResult> | undefined;
let client;
let runId: string | undefined;
async function until<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No ${label}`);
}
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 30000,
  }).connect();
  const run = store.createRun(
    {
      project: 'proof',
      flowType: 'dev',
      mode: 'autonomous',
      transport: 'tmux',
      runner: 'claude',
      ticketOrPr: 'Question fixture',
      slotId: 'question-slot',
    },
    { createdByPrincipalId: person.id, nativeOwnerPrincipalId: person.id },
  );
  runId = run.id;
  const task = path.join(root, 'repo/tasks/proof/TASK.md');
  const signal = path.join(root, 'repo/tasks/proof/SIGNAL.json');
  const startedAt = new Date().toISOString();
  await writeFile(task, '# Disposable worker question proof\n');
  await writeFile(
    signal,
    JSON.stringify({
      status: 'running',
      attemptId: 'fixture-attempt',
      role: 'dev',
      contextId: 'dev',
      timestamp: startedAt,
    }),
  );
  store.updateRun(run.id, {
    status: 'monitoring',
    taskFile: task,
    steps: [{ name: 'monitor', status: 'running' }],
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Worker',
        runner: 'claude',
        status: 'working',
        runId,
        slotId: 'question-slot',
        signalAttemptId: 'fixture-attempt',
        signalFile: signal,
        taskFile: task,
        startedAt,
        attemptStartedAt: startedAt,
        target: { session: 'question-slot', window: 'dev', target: 'question-slot:dev' },
      },
    ],
  });
  const read = async () => (await client.call('run.get', { runId })).run;
  monitoring = monitorRun(runId, 'question-slot', controller.signal, {
    workerStatus: async () => 'working',
  });
  const blocked = await until(
    read,
    (value) => value.decisions.some((d: { resolvedAt?: string }) => !d.resolvedAt),
    'worker question decision',
  );
  assert.equal(
    blocked.status,
    'reconciling',
    'fixture has no independent progress hooks; the question is visible as a decision',
  );
  assert.equal(blocked.decisions.length, 1);
  const decision = blocked.decisions[0];
  assert.equal(decision.context.workerQuestion, true);
  if (permission) {
    assert.match(decision.description, /Do you want to continue/);
    assert.ok(paneCaptures >= 2, 'legacy permissions retain the existing two-poll detection');
    const previous = probes;
    await until(
      () => probes,
      (count) => count > previous + 2,
      'permission watcher probes',
    );
    const held = await read();
    assert.equal(held.decisions.length, 1);
    assert.equal(held.decisions[0].id, decision.id);
    assert.equal(
      held.decisions[0].resolvedAt,
      undefined,
      'no AskUserQuestion must not close an open permission handoff',
    );
    permissionOpen = false;
  } else {
    assert.match(decision.description, /Which network should the proof use\?/);
    assert.match(decision.description, /Testnet: Use the fixture/);
    assert.equal(paneCaptures, 0, 'the structured question must not depend on pane text');
    await writeFile(transcript, JSON.stringify(question));
    let previous = probes;
    await until(
      () => probes,
      (count) => count > previous + 1,
      'two unreadable probes',
    );
    assert.equal((await read()).decisions[0].resolvedAt, undefined, 'unreadable is not answered');
    await writeTranscript([question, { ...answer, sessionId: 'foreign' }]);
    previous = probes;
    await until(
      () => probes,
      (count) => count > previous + 1,
      'two unmatched-answer probes',
    );
    const held = await read();
    assert.equal(held.decisions.length, 1, 'repeated observations do not duplicate the decision');
    assert.equal(held.decisions[0].id, decision.id);
    assert.equal(held.decisions[0].resolvedAt, undefined);
    await writeTranscript([question, answer]);
  }
  const resumed = await until(
    read,
    (value) =>
      value.status === 'monitoring' && value.decisions[0]?.resolvedAction === 'question-closed',
    'automatic resumed state',
  );
  controller.abort();
  const monitorResult = await monitoring;
  assert.equal(resumed.decisions.length, 1);
  assert.deepEqual(
    monitorResult.violations,
    [],
    'an operator question must never trigger a nudge violation',
  );
  const result = {
    pass: true,
    method: 'run.get',
    question: decision.description,
    cases: permission
      ? [
          'valid Bash transcript preserves permission detection',
          'open permission is not closed by no AskUserQuestion',
          'existing permission close resumes monitoring',
          'zero nudges',
        ]
      : [
          'structured question visible without pane',
          'unknown retains decision',
          'foreign answer ignored',
          'deduplicated',
          'exact answer resumes monitoring',
          'zero nudges',
        ],
    monitorResult,
    modelTurns: 0,
    productOperations: 0,
    scope:
      'Authenticated gateway/production monitor/registered capability/real structured file adapter; native process registration and tmux transport are fixtures. No live runner UI or remote-node claim.',
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  controller.abort();
  if (runId)
    for (const decision of store.getRun(runId)?.decisions ?? [])
      if (!decision.resolvedAt) resolveMonitorDecision(decision.id, 'abort');
  if (monitoring) await monitoring;
  client?.close();
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (runId) {
    store.updateRun(runId, { status: 'done' });
    await store.deleteRun(runId);
  }
  await rm(root, { recursive: true, force: true });
}
process.exit(0);
