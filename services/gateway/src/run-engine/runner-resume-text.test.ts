// The resume Continue sends has to arrive as itself. The first version of this
// fix reused the budget helper, which rewrapped every message as
// "[Orchestrator] USAGE BUDGET WARNING: ... Complete or block the current
// checklist item and run the appropriate mark terminal command." — so Continue
// after a provider outage told the worker to mark the item it was still working
// on. The monitor test could not see it: it injects the sender, so it asserted
// the text going in and never the text going out.
//
// This drives the real `sendOneShotWorkerInstruction` and asserts on what
// reaches the pane.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');

const sends: { text: string; channel: string }[] = [];

const registry = await import('../runners/registry.js');
mock.module('../runners/registry.js', {
  namedExports: {
    ...registry,
    sendRunnerInstructionWithOutcome: async (
      _vars: unknown,
      _session: string,
      _runner: string,
      text: string,
      channel: string,
    ) => {
      sends.push({ text, channel });
      return 'typed-confirmed';
    },
  },
});

// Resolving the pane target shells out to tmux, which this isolated suite
// refuses; the text under test is chosen before that call.
const contexts = await import('../agents/contexts.js');
mock.module('../agents/contexts.js', {
  namedExports: {
    ...contexts,
    resolveAgentTarget: async (slotId: string) => ({ target: `${slotId}:dev`, session: slotId }),
  },
});

const { farmslotRoot } = await import('../fleet/state.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { sendOneShotWorkerInstruction } = await import('./run-monitor.js');
const { deleteTestRunIfPresent } = await import('./test-fixtures.js');
const { buildUsageBudgetNudgeMessage } = await import('./flow-usage-budget.js');

const RESUME =
  '[Orchestrator] The runner is available again. Continue the current task from where it stopped, per TASK.md; do not start over.';

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }): Promise<Run> {
  sends.length = 0;
  // The real sender resolves slot vars, so the slot needs a pool row.
  const project = `resume-text-${Math.random().toString(36).slice(2, 10)}`;
  const slotId = `${project}-slot`;
  const poolFile = path.join(farmslotRoot(), 'pool', `${project}.json`);
  await mkdir(path.dirname(poolFile), { recursive: true });
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'localhost',
      project,
      host: 'localhost',
      ssh_user: os.userInfo().username,
      platform: 'cli',
      os: 'darwin',
      slots: [{ id: slotId, enabled: true, repo: os.tmpdir(), session: slotId }],
    }),
  );
  t.after(() => rm(poolFile, { force: true }));
  const run = createRun({
    project,
    flowType: 'dev',
    mode: 'autonomous',
    ticketOrPr: 'TAT-4639',
    runner: 'pi',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'monitoring',
    slotId,
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Worker',
        runner: 'pi',
        status: 'working',
        runId: run.id,
        slotId,
        startedAt: new Date().toISOString(),
      },
    ],
  });
  return getRun(run.id)!;
}

test('a runner resume reaches the pane as itself', async (t) => {
  const run = await fixture(t);
  const delivery = await sendOneShotWorkerInstruction(
    run.id,
    run.slotId!,
    { text: RESUME, key: 'runner-resume', channel: 'run-monitor-resume' },
    'dev',
    'dev',
  );

  assert.equal(delivery, 'confirmed');
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.text, RESUME, 'the pane must receive the resume, not a rewrapped message');
  assert.equal(
    /USAGE BUDGET WARNING/i.test(sends[0]!.text),
    false,
    'a resume wrapped as a budget warning ends with "mark the current checklist item", which is the opposite of continuing',
  );
  assert.equal(
    /\bmark\b/i.test(sends[0]!.text),
    false,
    'a resume must not instruct a terminal mark: the worker has unfinished work',
  );
  assert.equal(sends[0]!.channel, 'run-monitor-resume');
});

// The budget warning still has to arrive wrapped. Its caller now owns the
// wrapping, so this is the case that would catch the wrapper being dropped.
test('a usage-budget warning still reaches the pane wrapped', async (t) => {
  const run = await fixture(t);
  const delivery = await sendOneShotWorkerInstruction(
    run.id,
    run.slotId!,
    {
      text: buildUsageBudgetNudgeMessage('dev usage budget exceeded'),
      key: 'budget',
      channel: 'run-monitor-budget',
    },
    'dev',
    'dev',
  );

  assert.equal(delivery, 'confirmed');
  assert.match(sends[0]!.text, /USAGE BUDGET WARNING/i);
  assert.match(sends[0]!.text, /dev usage budget exceeded/);
  assert.equal(sends[0]!.channel, 'run-monitor-budget');
});
