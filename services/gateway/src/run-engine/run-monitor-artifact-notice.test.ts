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

// A stale receipt rejected f613c8af's completion signal; the card said "The worker was
// notified" while the instruction never reached the pane. The card now says what happened.
const MESSAGE =
  'TASK_ARTIFACT_CONTRACT_FAIL\n- CHECKLIST.md step 10 (ci.local_check): Command or publishable inputs changed; rerun this mark step';
type Delivery = 'delivered' | 'undelivered' | 'throws';
let tmuxDelivery: Delivery = 'delivered';
let nativeOutcome = 'confirmed';
const sent: string[] = [];

const contract = await import('../tasks/worker-terminal-contract.js');
mock.module('../tasks/worker-terminal-contract.js', {
  namedExports: {
    ...contract,
    validateTerminalSignalArtifacts: async () => ({
      ok: false,
      kind: 'contract',
      message: MESSAGE,
    }),
  },
});
const registry = await import('../runners/registry.js');
mock.module('../runners/registry.js', {
  namedExports: {
    ...registry,
    sendRunnerInstructionSafely: async (
      _vars: unknown,
      _target: string,
      _runner: string,
      text: string,
    ) => {
      sent.push(text);
      if (tmuxDelivery === 'throws') throw new Error('tmux send failed');
      return tmuxDelivery === 'delivered';
    },
  },
});
const native = await import('../runners/native/worker-control.js');
mock.module('../runners/native/worker-control.js', {
  namedExports: {
    ...native,
    sendNativeWorkerInstruction: async ({ text }: { text: string }) => {
      sent.push(text);
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

async function fixture(t: TestContext, transport: 'tmux' | 'native') {
  tmuxDelivery = 'delivered';
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
  const run =
    transport === 'native'
      ? (() => {
          process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'fixture-service';
          return createRun(
            {
              project,
              flowType: 'dev',
              mode: 'autonomous',
              ticketOrPr: 'NOTICE-1',
              transport: 'native',
              runner: 'codex',
            },
            { nativeOwnerPrincipalId: 'fixture-service' },
          );
        })()
      : createRun({
          project,
          flowType: 'dev',
          mode: 'autonomous',
          ticketOrPr: 'NOTICE-1',
          runner: 'claude',
        });
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
  };
  await writeFile(signalFile, JSON.stringify(complete));
  await writeFile(path.join(taskDir, 'TASK.md'), '# Worker\n');
  updateRun(run.id, {
    status: 'monitoring',
    ...(transport === 'native' ? { transport: 'native' as const } : {}),
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

const NOTIFIED = /The worker was notified/;
const NOT_NOTIFIED =
  /The worker was not notified: tell it to fix the listed artifacts and run \.\/mark complete again\./;

for (const [delivery, label] of [
  ['undelivered', 'an undelivered'],
  ['throws', 'a failed'],
] as const) {
  test(`${label} tmux notice is not reported as delivered`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t, 'tmux');
    tmuxDelivery = delivery;
    void f.start();
    const card = await nextCard(f.run.id);
    assert.equal(sent.length, 1, 'the monitor tried to tell the worker once');
    assert.doesNotMatch(card.description ?? '', NOTIFIED);
    assert.match(card.description ?? '', NOT_NOTIFIED);
    assert.match(card.description ?? '', /step 10 \(ci\.local_check\)/);
  });
}

test('a delivered tmux notice keeps the notified card', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 'tmux');
  void f.start();
  const card = await nextCard(f.run.id);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /rejected by the artifact contract/);
  assert.match(card.description ?? '', NOTIFIED);
  assert.doesNotMatch(card.description ?? '', NOT_NOTIFIED);
});

test(
  'the same rejection on the next poll keeps the first outcome',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, 'tmux');
    tmuxDelivery = 'undelivered';
    void f.start();
    const first = await nextCard(f.run.id);
    tmuxDelivery = 'delivered';
    resolveMonitorDecision(first.id, 'signal-written');
    const second = await nextCard(f.run.id, 1);
    assert.equal(sent.length, 1, 'an unchanged rejection is not sent again');
    assert.doesNotMatch(second.description ?? '', NOTIFIED);
    assert.match(second.description ?? '', NOT_NOTIFIED);
  },
);

test('an unconfirmed native notice is not reported as delivered', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 'native');
  nativeOutcome = 'unconfirmed';
  void f.start();
  const card = await nextCard(f.run.id);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(card.description ?? '', NOTIFIED);
  assert.match(card.description ?? '', NOT_NOTIFIED);
});
