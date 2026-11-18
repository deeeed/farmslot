import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

const run: Run = {
  ...makeRun(),
  id: 'effort-review',
  flowType: 'review-pr',
  slotId: null,
  ticketOrPr: 'example/app#42',
  effort: 'xhigh',
  transport: 'tmux',
  nativeOwnerPrincipalId: 'owner',
  reviewWorkspaceTarget: { machine: 'local' },
  reviewWorkspace: {
    workspaceId: 'workspace',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: '/owned/source',
    taskPath: '/owned/task',
    artifactPath: '/owned/task/artifacts',
  },
};
run.metrics.runner = 'codex';
run.metrics.model = 'gpt-6.1-sol';
const realStore = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...realStore,
    getRun: () => run,
    getRunWithArchived: async () => run,
    getAllRuns: () => [run],
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    persistRunNow: async () => {},
  },
});
mock.module('../agents/contexts.js', {
  namedExports: {
    upsertAgentContext: async (_runId: string, _id: string, patch: Partial<AgentContext>) => {
      const context =
        run.agentContexts?.[0] ??
        ({
          id: 'review',
          role: 'review',
          label: 'Review',
          runId: run.id,
          slotId: null,
          status: 'launching',
        } satisfies AgentContext);
      Object.assign(context, patch);
      run.agentContexts = [context];
      return context;
    },
  },
});
mock.module('../security/native-worker-owner.js', {
  namedExports: { assertNativeRunOwner: () => {} },
});
const workspaceSkills = await import('../review-workspaces/skills.js');
mock.module('../review-workspaces/skills.js', {
  namedExports: { ...workspaceSkills, bindReviewWorkspaceSupportValue: (value: string) => value },
});
mock.module('../review/session-mode.js', {
  namedExports: { WarmReviewRefusal: class extends Error {} },
});
const realProjectEnv = await import('../core/project-env.js');
mock.module('../core/project-env.js', {
  namedExports: {
    ...realProjectEnv,
    machineShellEnv: () => ({}),
    resolveProjectCommandEnv: () => ({ set: {}, unset: [] }),
  },
});
// Pass-through mocks: this suite only needs the pool and project reads stubbed,
// and a partial namedExports set crashes whichever shard loads it as soon as
// anything else in the graph imports another export (cx-ci saw gateway shard 10
// fail on `farmslotRoot`, which core/state.ts reads at module load).
const realConfig = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    farmslotRoot: () => path.join(os.tmpdir(), 'review-context-farmslot-root'),
    loadMachinePool: async () => ({ machine: 'local' }),
    loadProjectVars: async () => ({ projectJson: {} }),
  },
});
const realExec = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    execFileArgv: async () => ({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        runner: 'codex',
        model: run.metrics.model,
        startedAt: new Date().toISOString(),
      }),
    }),
  },
});
mock.module('./native/node.js', {
  namedExports: {
    execNativeNodeArgv: () => {
      throw new Error('Unexpected remote execution');
    },
  },
});
mock.module('./launch-command.js', {
  namedExports: {
    buildInteractiveRefinementRunnerCommand: () => 'configured-command',
    // Pass-through: this suite is about review context, not the resume guard.
    guardedSessionReloadCommand: (_runner: string, command: string) => command,
    interactiveRunnerExecutable: () => 'codex',
    modelQuestionsEnvironment: () => ({}),
    modelQuestionsForRun: () => undefined,
    workspaceTerminalSessionCreateArgv: () => undefined,
  },
});
const realRegistry = await import('./registry.js');
mock.module('./registry.js', {
  namedExports: {
    ...realRegistry,
    getRunnerDefinition: () => ({
      sessionContinuation: { native: true, terminal: { workspace: 'current' } },
    }),
  },
});
const { launchReviewTmux } = await import('./review-tmux.js');

test('slotless launch records the selected effort on its reviewer identity', async () => {
  await launchReviewTmux(run.id, 'Exact task', async () => {});
  assert.equal(run.agentContexts?.[0].effort, 'xhigh');
});
