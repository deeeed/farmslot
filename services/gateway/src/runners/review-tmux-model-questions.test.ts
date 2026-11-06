import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';
import type { RawPoolJson } from '@farmslot/slot-config';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const exec = await import('../core/exec.js');
const owners = await import('../security/native-worker-owner.js');
const pool = {
  machine: 'host',
  os: 'macos',
  host: 'localhost',
  project: 'demo',
  platform: 'test',
  ssh_user: 'fixture',
  slots: [],
} satisfies RawPoolJson;
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadMachinePool: async () => pool,
    loadProjectVars: async () => ({ projectJson: {} }),
  },
});
interface TerminalLaunch {
  command: string;
  environment: { set: Record<string, string> };
}
const terminalInputs: TerminalLaunch[] = [];
mock.module('../core/exec.js', {
  namedExports: {
    ...exec,
    // The review terminal script receives one JSON argument; answer as it would.
    execFileArgv: async (argv: string[]) => {
      terminalInputs.push(JSON.parse(argv.at(-1)!));
      return {
        exitCode: 0,
        stdout: JSON.stringify({ runner: run.metrics.runner, model: run.metrics.model }),
        stderr: '',
      };
    },
  },
});
mock.module('../security/native-worker-owner.js', {
  namedExports: { ...owners, assertNativeRunOwner: () => {} },
});
const { reviewTmuxOperation } = await import('./review-tmux.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');

let run: Run;
function reviewRun(runner: string, mode: Run['mode']): Run {
  return {
    ...makeRun(),
    id: 'terminal-review',
    project: 'demo',
    mode,
    nativeOwnerPrincipalId: 'owner',
    metrics: {
      nudgeCount: 0,
      runner,
      model: 'model-a',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'host',
      executionNodeId: 'local',
      checkoutPath: '/tmp/review.source',
      taskPath: '/tmp/review.task',
      artifactPath: '/tmp/review.task/artifacts',
    },
  };
}

for (const [runner, switched] of [
  // The list-valued Claude switch is followed by an option, so the prompt stays an argument.
  ['claude', /'--disallowedTools' 'AskUserQuestion' '--setting-sources'/u],
  ['codex', /'--config' 'tools\.experimental_request_user_input=\{enabled=false\}'/u],
] as const) {
  test(`a terminal ${runner} workspace review of an autonomous run launches without the question tool`, async () => {
    for (const mode of ['autonomous', 'interactive'] as const) {
      run = reviewRun(runner, mode);
      terminalInputs.length = 0;
      await reviewTmuxOperation(run, 'launch', 'Review the PR');
      const terminalInput = terminalInputs.at(-1);
      assert.ok(terminalInput);
      if (mode === 'autonomous') assert.match(terminalInput.command, switched);
      else assert.doesNotMatch(terminalInput.command, /AskUserQuestion|request_user_input/u);
    }
  });
}

test('a terminal OpenCode workspace review of an autonomous run denies the question tool', async () => {
  for (const mode of ['autonomous', 'interactive'] as const) {
    run = reviewRun('opencode', mode);
    terminalInputs.length = 0;
    await reviewTmuxOperation(run, 'launch', 'Review the PR');
    assert.equal(
      terminalInputs.at(-1)?.environment.set.OPENCODE_PERMISSION,
      mode === 'autonomous' ? '{"question":"deny"}' : undefined,
    );
  }
});

test('OpenCode terminal review can read every frozen reference without granting missing or unrelated roots', async () => {
  run = reviewRun('opencode', 'autonomous');
  assert(run.reviewWorkspace);
  run.reviewWorkspace.support = {
    path: '/frozen/support',
    sha256: 'a'.repeat(64),
    sources: [],
    skills: [],
    environment: {},
    references: [
      { name: 'consumer', path: '/frozen/reference', headSha: 'b'.repeat(40) },
      { name: 'absent', path: '/missing/reference', missing: true },
    ],
  };
  terminalInputs.length = 0;
  await reviewTmuxOperation(run, 'launch', 'Review references');
  const input = terminalInputs.at(-1);
  assert(input);
  assert(input.command.includes('/frozen/support/*'));
  assert(input.command.includes('/frozen/reference/*'));
  assert(!input.command.includes('/missing/reference'));
});
