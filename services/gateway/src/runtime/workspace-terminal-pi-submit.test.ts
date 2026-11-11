import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';
import type { RawPoolJson } from '@farmslot/slot-config';

import { writePiHook } from '../../../../scripts/runners/pi-farmslot-hook-writer.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'workspace-pi-submit-'));
process.env.FARMSLOT_HOME = root;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
after(() => rm(root, { recursive: true, force: true }));
await import('./mock-pty.test-support.js');

const checkout = path.join(root, 'source');
const task = path.join(root, 'task');
const observationDirectory = path.join(task, '.observability');
await mkdir(checkout);
await mkdir(task);
const session = 'review-submission-proof';
const pane = '%42';
const message = 'Correct the review artifact in the original task directory.';
const run: Run = {
  id: 'review-submission-proof',
  familyId: 'review-submission-proof',
  lane: 'production',
  flowType: 'review-pr',
  mode: 'autonomous',
  status: 'reviewing',
  project: 'proof',
  ticketOrPr: 'Submission regression',
  slotId: null,
  branch: null,
  taskFile: null,
  steps: [],
  decisions: [],
  metrics: { runner: 'pi', model: 'litellm/glm-5p3-flash', nudgeCount: 0 },
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
  nativeOwnerPrincipalId: 'test-owner',
  transport: 'tmux',
  reviewWorkspace: {
    workspaceId: 'submission-proof',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: checkout,
    taskPath: task,
    artifactPath: path.join(task, 'artifacts'),
  },
  agentContexts: [
    {
      id: 'review',
      role: 'review',
      label: 'Review',
      status: 'working',
      slotId: null,
      runId: 'review-submission-proof',
      runner: 'pi',
      target: { session, target: session },
    },
  ],
};
const pool: RawPoolJson = {
  machine: 'local',
  host: 'localhost',
  ssh_user: 'fixture',
  os: 'darwin',
  platform: 'test',
  project: 'proof',
  slots: [],
};
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadMachinePool: async () => pool,
    resolveProjectRuntimeDir: async () => '.agent',
  },
});
const ownership = await import('../security/native-worker-owner.js');
mock.module('../security/native-worker-owner.js', {
  namedExports: { ...ownership, assertNativeRunOwner: () => {} },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', { namedExports: { ...store, getRun: () => run } });
const state = await import('../core/state.js');
mock.module('../core/state.js', { namedExports: { ...state, readSlotRow: async () => null } });

let receipt: 'accepted' | 'missing' | 'foreign-pane' | 'stale' | 'wrong-prompt' = 'accepted';
let submitted = 0;
let pasted = '';
function acceptInput() {
  submitted++;
  if (receipt === 'missing') return;
  const clock = receipt === 'stale' ? mock.method(Date, 'now', () => 1) : undefined;
  try {
    writePiHook({
      obsDir: observationDirectory,
      event: 'UserPromptSubmit',
      sessionId: 'pi-owned-session',
      promptText: receipt === 'wrong-prompt' ? 'Unrelated input' : pasted,
      cwd: checkout,
      env: { TMUX_PANE: receipt === 'foreign-pane' ? '%99' : pane, FARMSLOT_RUNNER: 'pi' },
    });
  } finally {
    clock?.mock.restore();
  }
}
const actualExec = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...actualExec,
    execFileArgv: async (
      argv: string[],
      options?: Parameters<typeof actualExec.execFileArgv>[1],
    ) => {
      if (argv[0] === process.execPath && argv[1] === '-e')
        return { exitCode: 0, stdout: '[]', stderr: '' };
      assert.equal(argv[0], 'bash');
      const command = argv[2]!.trim();
      if (command.includes('# farmslot runner input execution-host guard')) {
        if (command.includes('send-keys')) acceptInput();
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command.includes('display-message') || command.includes('list-panes'))
        return {
          exitCode: 0,
          stdout: command.includes('#{pane_current_command}') ? `${pane}|123|pi` : pane,
          stderr: '',
        };
      if (command.includes('set-buffer')) {
        assert.ok(command.includes(message), 'tmux receives the requested correction text');
        pasted = message;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command.includes('ps -')) return { exitCode: 0, stdout: '123', stderr: '' };
      assert.doesNotMatch(command, /tmux/, 'unhandled tmux must never reach a real server');
      return actualExec.execFileArgv(argv, options);
    },
  },
});
const { workspaceTerminalOperation } = await import('./workspace-terminal.js');
const { reviewWorkspaceRunnerVars } = await import('../runners/review-workspace-context.js');
beforeEach(async () => {
  receipt = 'accepted';
  submitted = 0;
  pasted = '';
  await rm(observationDirectory, { recursive: true, force: true });
});

test('review runner vars bind Pi observations to the task while preserving the source cwd', async () => {
  const vars = await reviewWorkspaceRunnerVars(run);
  assert(vars);
  assert.equal(vars.remoteRepo, checkout);
  assert.equal(vars.repo, checkout);
  assert.equal(
    'runnerObservabilityDir' in vars && vars.runnerObservabilityDir,
    observationDirectory,
  );
  const ordinary = structuredClone(run);
  ordinary.metrics.runner = 'claude';
  ordinary.agentContexts![0].runner = 'claude';
  const ordinaryVars = await reviewWorkspaceRunnerVars(ordinary);
  assert(ordinaryVars);
  assert.equal(
    'runnerObservabilityDir' in ordinaryVars && ordinaryVars.runnerObservabilityDir !== undefined,
    false,
  );
});

test('slotless Pi correction confirms its real task-scoped input hook without worker task delivery', async () => {
  await workspaceTerminalOperation(run, 'send', { text: message, enter: true });
  assert.equal(submitted, 1);
  assert.equal(pasted, message);
});

for (const rejected of ['missing', 'foreign-pane', 'stale', 'wrong-prompt'] as const) {
  test(`slotless Pi correction rejects a ${rejected} acceptance receipt without retyping`, async () => {
    receipt = rejected;
    await assert.rejects(
      workspaceTerminalOperation(run, 'send', { text: message, enter: true }),
      /Runner submission was not confirmed; text may be buffered/,
    );
    assert.equal(submitted, 1);
    assert.equal(pasted, message);
  });
}
