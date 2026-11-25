// @farmslot:serial — owns temporary project and pool rows in this checkout.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import type { RunDecision, WorkerSignal } from '@farmslot/protocol';

import '../core/private-pool.test-support.js';
import '../runtime/mock-pty.test-support.js';

import type { RunnerInstructionOutcome } from '../runners/registry.js';

import type { WorkerInstructionDelivery } from './run-monitor.js';

// A stale receipt rejected f613c8af's completion signal; the card said "The worker was
// notified" while the worker pane sat idle. The card now reports what the send did.
const rejection = (detail: string, command = 'complete') =>
  'Terminal SIGNAL.json was rejected by the worker artifact contract. Fix the listed artifacts, ' +
  `then run ./mark ${command} again.\n\nTASK_ARTIFACT_CONTRACT_FAIL\n- ${detail}`;
const STALE = rejection(
  'CHECKLIST.md step 10 (ci.local_check): Command or publishable inputs changed; rerun this mark step',
);
let contractMessage = STALE;
let tmuxOutcome: RunnerInstructionOutcome | 'throws' = 'sent';
let nativeOutcome: WorkerInstructionDelivery | 'throws' = 'confirmed';
const sent: string[] = [];

const contract = await import('../tasks/worker-terminal-contract.js');
mock.module('../tasks/worker-terminal-contract.js', {
  namedExports: {
    ...contract,
    validateTerminalSignalArtifacts: async (): Promise<
      Awaited<ReturnType<typeof contract.validateTerminalSignalArtifacts>>
    > => ({ ok: false, kind: 'artifact', message: contractMessage }),
  },
});
const registry = await import('../runners/registry.js');
mock.module('../runners/registry.js', {
  namedExports: {
    ...registry,
    sendRunnerInstructionWithOutcome: async (
      ...[, , , text]: Parameters<typeof registry.sendRunnerInstructionWithOutcome>
    ): Promise<RunnerInstructionOutcome> => {
      sent.push(text);
      if (tmuxOutcome === 'throws') throw new Error('ssh to the slot failed');
      return tmuxOutcome;
    },
  },
});
const native = await import('../runners/native/worker-control.js');
mock.module('../runners/native/worker-control.js', {
  namedExports: {
    ...native,
    sendNativeWorkerInstruction: async ({
      text,
    }: Parameters<
      typeof native.sendNativeWorkerInstruction
    >[0]): Promise<WorkerInstructionDelivery> => {
      sent.push(text);
      if (nativeOutcome === 'throws') throw new Error('native host stopped responding');
      return nativeOutcome;
    },
  },
});
const contexts = await import('../agents/contexts.js');
mock.module('../agents/contexts.js', {
  namedExports: {
    ...contexts,
    resolveAgentTarget: async () => ({ target: 'artifact-notice:dev' }),
  },
});

const { poolDirectory } = await import('../core/config.js');
const { farmslotRoot } = await import('../fleet/state.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { monitorRun, resolveMonitorDecision } = await import('./run-monitor.js');
const { deleteTestRunIfPresent } = await import('./test-fixtures.js');

type Transport = 'tmux' | 'native' | 'scripted' | 'scripted-non-artifact';

async function fixture(
  t: TestContext,
  transport: Transport,
  signal: Partial<WorkerSignal> = {},
  launchCommand?: string,
) {
  contractMessage = STALE;
  tmuxOutcome = 'sent';
  nativeOutcome = 'confirmed';
  sent.length = 0;
  const project = `artifact-notice-${randomUUID()}`;
  const projectDir = path.join(farmslotRoot(), 'projects', project);
  const poolFile = path.join(poolDirectory(), `${project}.json`);
  const worker = await mkdtemp(path.join(os.tmpdir(), 'artifact-notice-'));
  const taskDir = path.join(projectDir, 'tasks/dev/fixture');
  const signalFile = path.join(worker, 'SIGNAL.json');
  const slotId = `${project}-slot`;
  const controller = new AbortController();
  let execution: Promise<unknown> | undefined;
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  const base = {
    project,
    flowType: 'dev' as const,
    mode: 'autonomous' as const,
    ticketOrPr: 'NOTICE-1',
  };
  if (transport === 'native') process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'fixture-service';
  const run =
    transport === 'native'
      ? createRun(
          { ...base, transport: 'native', runner: 'codex' },
          { nativeOwnerPrincipalId: 'fixture-service' },
        )
      : createRun({ ...base, runner: 'claude' });
  t.after(async () => {
    controller.abort();
    for (const decision of getRun(run.id)?.decisions ?? []) {
      if (!decision.resolvedAt) resolveMonitorDecision(decision.id, 'abort');
    }
    await Promise.allSettled([execution]);
    await deleteTestRunIfPresent(run.id);
    await rm(projectDir, { recursive: true, force: true });
    await rm(poolFile, { force: true });
    await rm(worker, { recursive: true, force: true });
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  });
  await mkdir(taskDir, { recursive: true });
  await mkdir(path.dirname(poolFile), { recursive: true });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      monitoring: {
        poll_interval_min: 1 / 60_000,
        stuck_timeout_min: 10,
        idle_timeout_min: 10,
        total_timeout_min: 1,
        max_nudges: 0,
      },
    }),
  );
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'localhost',
      project,
      host: 'localhost',
      ssh_user: os.userInfo().username,
      platform: 'cli',
      os: 'darwin',
      slots: [{ id: slotId, enabled: true, repo: worker, session: slotId }],
    }),
  );
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const complete: WorkerSignal = {
    status: 'complete',
    outcome: 'success',
    disposition: 'fixed',
    attemptId: 'owned-attempt',
    role: 'dev',
    contextId: 'worker',
    step: '23. Signal completion',
    timestamp: new Date().toISOString(),
    evidence: { reportPath: 'artifacts/pr-description.md' },
    ...signal,
  };
  await writeFile(signalFile, JSON.stringify(complete));
  await writeFile(path.join(taskDir, 'TASK.md'), '# Worker\n');
  const current = getRun(run.id)!;
  updateRun(run.id, {
    status: 'monitoring',
    ...(transport === 'native' ? { transport: 'native' as const } : {}),
    ...(transport === 'scripted'
      ? {
          completionPolicy: 'artifact-only' as const,
          scripted: { mode: 'command' as const, commandRef: 'fixture-command' },
          metrics: { ...current.metrics, runner: 'scripted' },
        }
      : {}),
    // A scripted run that is not an artifact-only command run has no worker either.
    ...(transport === 'scripted-non-artifact'
      ? {
          scripted: { mode: 'command' as const, commandRef: 'fixture-command' },
          metrics: { ...current.metrics, runner: 'scripted' },
        }
      : {}),
    ...(launchCommand
      ? {
          steps: current.steps.map((step) =>
            step.name === 'dispatch'
              ? { ...step, outputs: { ...step.outputs, launchCommand } }
              : step,
          ),
        }
      : {}),
    slotId,
    taskFile: path.join(taskDir, 'TASK.md'),
    agentContexts: [
      {
        id: 'worker',
        role: 'dev',
        label: 'Worker',
        runner: transport === 'native' ? 'codex' : 'claude',
        status: 'working',
        runId: run.id,
        slotId,
        signalAttemptId: 'owned-attempt',
        signalFile,
        taskFile: path.join(worker, 'TASK.md'),
        startedAt,
        attemptStartedAt: startedAt,
      },
    ],
    monitorState: {
      nudgeCount: 0,
      startedAt,
      lastPollAt: startedAt,
      lastStructuredProgressAt: startedAt,
    },
  });
  const start = () => {
    execution = monitorRun(run.id, slotId, controller.signal, {
      workerStatus: async () => 'working',
      waitForWorker: async () => 'working',
      violations: async () => [],
    });
    return execution;
  };
  return { run, start };
}

async function nextCard(runId: string, seen = 0): Promise<RunDecision> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const cards = (getRun(runId)?.decisions ?? []).filter(
      (decision) => decision.type === 'monitor_interactive_handoff',
    );
    if (cards.length > seen) return cards[seen]!;
    if (Date.now() > deadline) assert.fail('no artifact-contract card');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const NOTIFIED = /The worker was notified\./;
const UNCONFIRMED =
  /The notice may not have reached the worker yet: check the worker before sending it again\./;
const notNotified = (command: string) =>
  new RegExp(
    `The worker was not notified: tell it to fix the problem below and run \\./mark ${command} again\\.`,
  );
const NOT_NOTIFIED = notNotified('complete');
const NOTICES = [NOTIFIED, UNCONFIRMED, NOT_NOTIFIED, /has no worker to notify/];

function assertCard(card: RunDecision, expected: RegExp) {
  const text = card.description ?? '';
  for (const notice of NOTICES) {
    if (notice.source === expected.source) assert.match(text, notice);
    else assert.doesNotMatch(text, notice);
  }
  assert.match(text, /step 10 \(ci\.local_check\)/);
}

type NoticeCase = { name: string; card: RegExp } & (
  | { transport: 'tmux'; outcome: RunnerInstructionOutcome | 'throws' }
  | { transport: 'native'; outcome: WorkerInstructionDelivery | 'throws' }
);
const cases: NoticeCase[] = [
  { name: 'a confirmed tmux send', transport: 'tmux', outcome: 'sent', card: NOTIFIED },
  {
    name: 'a tmux send held untouched',
    transport: 'tmux',
    outcome: 'held-untouched',
    card: NOT_NOTIFIED,
  },
  {
    name: 'a tmux send that throws untouched',
    transport: 'tmux',
    outcome: 'throws',
    card: NOT_NOTIFIED,
  },
  {
    name: 'tmux text typed but unconfirmed',
    transport: 'tmux',
    outcome: 'typed-unconfirmed',
    card: UNCONFIRMED,
  },
  { name: 'a confirmed native send', transport: 'native', outcome: 'confirmed', card: NOTIFIED },
  { name: 'a native send attempted', transport: 'native', outcome: 'attempted', card: UNCONFIRMED },
  { name: 'a native send queued', transport: 'native', outcome: 'queued', card: UNCONFIRMED },
  {
    name: 'a native send not attempted',
    transport: 'native',
    outcome: 'not-attempted',
    card: NOT_NOTIFIED,
  },
  { name: 'a native send that throws', transport: 'native', outcome: 'throws', card: UNCONFIRMED },
];

for (const c of cases) {
  test(`${c.name} is reported as such on the card`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t, c.transport);
    if (c.transport === 'tmux') tmuxOutcome = c.outcome;
    else nativeOutcome = c.outcome;
    void f.start();
    assertCard(await nextCard(f.run.id), c.card);
    assert.equal(sent.length, 1, 'the monitor tried to tell the worker once');
    assert.match(sent[0]!, /rejected by the artifact contract/);
  });
}

test(
  'the same rejection on the next poll keeps the first outcome',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, 'tmux');
    tmuxOutcome = 'held-untouched';
    void f.start();
    const first = await nextCard(f.run.id);
    tmuxOutcome = 'sent';
    resolveMonitorDecision(first.id, 'signal-written');
    assertCard(await nextCard(f.run.id, 1), NOT_NOTIFIED);
    assert.equal(sent.length, 1, 'an unchanged rejection is not sent again');
  },
);

test('a new rejection is sent again and reported on its own', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 'tmux');
  void f.start();
  const first = await nextCard(f.run.id);
  assertCard(first, NOTIFIED);
  contractMessage = rejection(
    'CHECKLIST.md step 10 (ci.local_check): Command did not pass, exit 1',
  );
  tmuxOutcome = 'held-untouched';
  resolveMonitorDecision(first.id, 'signal-written');
  assertCard(await nextCard(f.run.id, 1), NOT_NOTIFIED);
  assert.equal(sent.length, 2, 'a changed rejection is a new notice');
});

test(
  'a headless worker that takes no pane input is not sent the notice',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(
      t,
      'tmux',
      {},
      "cd /repo && claude --model sonnet --print 'Read TASK.md'",
    );
    void f.start();
    assertCard(await nextCard(f.run.id), NOT_NOTIFIED);
    assert.equal(sent.length, 0);
  },
);

test('a no-change signal names ./mark no-change', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 'tmux', {
    disposition: 'already_fixed',
    evidence: { reportPath: 'artifacts/no-change-report.md' },
  });
  contractMessage = rejection(
    'CHECKLIST.md step 10 (ci.local_check): Command or publishable inputs changed; rerun this mark step',
    'no-change',
  );
  tmuxOutcome = 'held-untouched';
  void f.start();
  assertCard(await nextCard(f.run.id), notNotified('no-change'));
  assert.match(sent[0]!, /run \.\/mark no-change again/);
});

for (const transport of ['scripted', 'scripted-non-artifact'] as const) {
  test(`a ${transport} run sends no worker notice`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t, transport);
    void f.start();
    assertCard(await nextCard(f.run.id), /has no worker to notify/);
    assert.equal(sent.length, 0);
  });
}
