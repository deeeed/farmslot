import assert from 'node:assert/strict';
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
mock.module('../runs/store.js', {
  namedExports: { getRun: () => run, getAllRuns: () => [run], persistRunNow: async () => {} },
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
mock.module('../review-workspaces/skills.js', {
  namedExports: { bindReviewWorkspaceSupportValue: (value: string) => value },
});
mock.module('../review/session-mode.js', {
  namedExports: { WarmReviewRefusal: class extends Error {} },
});
mock.module('../core/project-env.js', {
  namedExports: { resolveProjectCommandEnv: () => ({ set: {}, unset: [] }) },
});
mock.module('../core/config.js', {
  namedExports: {
    loadMachinePool: async () => ({ machine: 'local' }),
    loadProjectVars: async () => ({ projectJson: {} }),
  },
});
mock.module('../core/exec.js', {
  namedExports: {
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
    interactiveRunnerExecutable: () => 'codex',
    modelQuestionsEnvironment: () => ({}),
    modelQuestionsForRun: () => undefined,
    workspaceTerminalSessionCreateArgv: () => undefined,
  },
});
mock.module('./registry.js', {
  namedExports: { getRunnerDefinition: () => ({ workspaceTerminalSession: 'resume-session' }) },
});
const { launchReviewTmux } = await import('./review-tmux.js');

test('slotless launch records the selected effort on its reviewer identity', async () => {
  await launchReviewTmux(run.id, 'Exact task', async () => {});
  assert.equal(run.agentContexts?.[0].effort, 'xhigh');
});
