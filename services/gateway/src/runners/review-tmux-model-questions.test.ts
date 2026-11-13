import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';
import type { RawPoolJson, RawProjectJson } from '@farmslot/slot-config';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const exec = await import('../core/exec.js');
const owners = await import('../security/native-worker-owner.js');
const pool: RawPoolJson = {
  machine: 'host',
  os: 'macos',
  host: 'localhost',
  project: 'demo',
  platform: 'test',
  ssh_user: 'fixture',
  slots: [],
};
let projectJson: RawProjectJson = {};
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadMachinePool: async () => pool,
    loadProjectVars: async () => ({ projectJson }),
  },
});
interface TerminalLaunch {
  command: string;
  environment: { set: Record<string, string>; unset: string[] };
  temporaryDirectoryVariables: string[];
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
      assert.deepEqual(
        terminalInput.temporaryDirectoryVariables,
        runner === 'claude' ? ['CLAUDE_CODE_TMPDIR'] : [],
      );
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

test('slotless Pi static reviews load the frozen provider extension for router and LiteLLM models', async () => {
  for (const model of ['router/review-model', 'litellm/review-model']) {
    run = reviewRun('pi', 'autonomous');
    run.slotId = null;
    run.metrics.model = model;
    run.effort = ' MAX ';
    terminalInputs.length = 0;
    await reviewTmuxOperation(run, 'launch', 'Review the PR');
    const input = terminalInputs.at(-1);
    assert(input);
    assert(input.command.includes(`--model '${model}'`));
    assert(input.command.includes('--thinking max'));
    assert(input.command.includes("FARMSLOT_THINKING='max'"));
    assert(input.command.includes("FARMSLOT_RUNNER='pi'"));
    assert(input.command.includes(`FARMSLOT_MODEL='${model}'`));
    assert(!input.command.includes('FARMSLOT_SLOT_ID='));
    assert(input.command.includes("FARMSLOT_PI_WORKSPACE_TRUST='untrusted'"));
    assert(
      input.command.includes(
        "-e '/tmp/review.task/inputs/runner-observability/bin/pi-farmslot-observability.ts'",
      ),
    );
    assert(input.command.includes('RUNNER_OBSERVABILITY_BUNDLE_MISMATCH'));
    assert(!input.command.includes(' --approve'));
    assert(!input.command.includes('/tmp/review.source/.agent'));
  }
});

test('slotless reviews receive pool-only providers after project defaults and preserve frozen support', async (t) => {
  const providerEnv = {
    FARMSLOT_PI_ROUTER_URL: 'https://router.example.invalid/v1',
    FARMSLOT_PI_ROUTER_KEY: 'synthetic-router-key',
    LITELLM_URL: 'https://litellm.example.invalid/v1',
    LITELLM_API_KEY: 'synthetic-litellm-key',
  };
  for (const name of Object.keys(providerEnv)) {
    const inherited = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (inherited === undefined) delete process.env[name];
      else process.env[name] = inherited;
    });
  }
  pool.env = { ...providerEnv, REVIEW_LIBRARY: '/mutable/pool/library', REVIEW_MODE: 'pool' };
  projectJson = {
    command_env: {
      unset: ['FARMSLOT_PI_ROUTER_URL', 'LITELLM_API_KEY', 'REMOVE_FOR_REVIEW'],
      set: { REVIEW_MODE: 'project' },
      domains: { review: { set: { REVIEW_MODE: 'domain', DOMAIN_DEFAULT: 'review' } } },
    },
  };
  t.after(() => {
    delete pool.env;
    projectJson = {};
  });
  for (const model of ['router/review-model', 'litellm/review-model']) {
    run = reviewRun('pi', 'autonomous');
    run.slotId = null;
    run.domain = 'review';
    run.metrics.model = model;
    assert(run.reviewWorkspace);
    run.reviewWorkspace.support = {
      path: '/frozen/support',
      sha256: 'a'.repeat(64),
      sources: [],
      skills: [],
      environment: { REVIEW_LIBRARY: '{{support}}/library' },
    };
    terminalInputs.length = 0;
    await reviewTmuxOperation(run, 'launch', 'Review the PR');
    const input = terminalInputs.at(-1);
    assert(input);
    for (const [name, value] of Object.entries(providerEnv)) {
      assert.equal(process.env[name], undefined);
      assert.equal(input.environment.set[name], value);
      assert(!input.environment.unset.includes(name));
      assert(!input.command.includes(value));
    }
    assert.equal(input.environment.set.REVIEW_MODE, 'pool');
    assert.equal(input.environment.set.DOMAIN_DEFAULT, 'review');
    assert.equal(input.environment.set.REVIEW_LIBRARY, '/frozen/support/library');
    assert(input.environment.unset.includes('REMOVE_FOR_REVIEW'));
    assert(input.command.includes("FARMSLOT_PI_WORKSPACE_TRUST='untrusted'"));
  }
});
