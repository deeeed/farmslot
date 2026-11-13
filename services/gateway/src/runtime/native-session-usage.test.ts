import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import type { ProjectVars } from '../core/config.js';
import { makeVars } from '../runners/test-fixtures.js';

let returnedSession = 'conversation';
const slotReads: string[] = [];
const config = await import('../core/config.js');
let poolEnvironment: Record<string, string> = {};
const poolReads: string[] = [];
let projectJson: ProjectVars['projectJson'] = {
  command_env: { set: { LITELLM_URL: 'http://project.invalid' } },
};
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadMachinePool: async (machine: string) => {
      poolReads.push(machine);
      return { env: poolEnvironment };
    },
    loadSlotVars: async (slotId: string) => {
      slotReads.push(slotId);
      return makeVars({ slotId, projectName: 'fixture' });
    },
    loadProjectVars: async () => ({
      projectName: 'fixture',
      runtimeDir: '.agent',
      artifactDir: '.task',
      projectJson,
    }),
  },
});

const calls: Array<{ owner: string; node: string; argv: string[] }> = [];
mock.module('../runners/native/node.js', {
  namedExports: {
    execNativeNodeArgv: async (owner: string, node: string, argv: string[]) => {
      calls.push({ owner, node, argv });
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify([
          {
            key: 'review',
            runnerSessionId: returnedSession,
            sessionPath: '/owned/transcript.jsonl',
            output:
              'model=recorded-model\nturns=2\ninput_tokens=10\noutput_tokens=20\ntotal_tokens=30\ncache_read=4\ncost_usd=0.1',
          },
        ]),
      };
    },
  },
});
const { extractNativeAgentSessionUsage, nativeRunUsageWindow } =
  await import('./native-session-usage.js');

test('native run accounting keeps the earliest conversation launch through retries', async () => {
  const { makeRun } = await import('../run-completion/test-fixtures.js');
  const run = makeRun({ id: 'queued-run', createdAt: '2026-01-01T00:00:00Z' });
  run.sessionUsage = [
    {
      runner: 'claude',
      runnerSessionId: 'conversation',
      startedAt: '2026-01-02T00:00:00Z',
      measuredAt: '2026-01-02T00:01:00Z',
      source: 'runner-transcript',
    },
  ];
  assert.deepEqual(
    nativeRunUsageWindow(run, {
      runner: 'claude',
      runnerSessionId: 'conversation',
      startedAt: '2026-01-02T00:02:00Z',
    }),
    { startedAt: '2026-01-02T00:00:00Z', completedAt: undefined },
  );
  assert.throws(
    () => nativeRunUsageWindow(run, { runner: 'claude', runnerSessionId: 'different' }),
    /no recorded launch boundary/,
  );
});

test('native accounting follows the recorded reviewer owner/node rather than the producing slot', async () => {
  for (const runner of ['claude', 'codex']) {
    const result = await extractNativeAgentSessionUsage({
      vars: { ...makeVars(), machine: 'producing-node' },
      runner,
      runnerSessionId: 'conversation',
      nativeSession: {
        sessionId: 'host',
        executionNodeId: 'reviewer-node',
        ownerPrincipalId: 'review-owner',
        leaseId: 'lease',
        commandId: 'command',
      },
    });
    assert.equal(result.source, 'runner-transcript');
    assert.equal(result.totalTokens, 30);
    assert.equal(result.runnerSessionId, 'conversation');
    assert.equal(calls.at(-1)?.node, 'reviewer-node');
    assert.equal(calls.at(-1)?.owner, 'review-owner');
    assert.equal(JSON.parse(calls.at(-1)!.argv.at(-2)!)[0].runner, runner);
  }
  returnedSession = 'foreign-conversation';
  const failed = await extractNativeAgentSessionUsage({
    vars: makeVars(),
    runner: 'claude',
    runnerSessionId: 'conversation',
    nativeSession: {
      sessionId: 'host',
      executionNodeId: 'reviewer-node',
      ownerPrincipalId: 'review-owner',
      leaseId: 'lease',
      commandId: 'command',
    },
  });
  assert.equal(failed.source, 'unavailable');
  assert.equal(failed.totalTokens, undefined);
  assert.match(failed.error ?? '', /identity changed/);
});

test('native accounting prices through the owning pool environment without sending credentials to the node', async (t) => {
  returnedSession = 'conversation';
  const directory = await (await import('node:fs/promises')).mkdtemp('/tmp/native-pricing-');
  t.after(() =>
    import('node:fs/promises').then((fs) => fs.rm(directory, { recursive: true, force: true })),
  );
  poolEnvironment = {
    LITELLM_URL: 'http://owning-pool.invalid',
    LITELLM_API_KEY: 'synthetic-key',
    FARMSLOT_LITELLM_PRICING_CACHE_DIR: directory,
  };
  t.after(() => {
    poolEnvironment = {};
  });
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json({
      data: [{ model_name: 'fixture', model_info: { input_cost_per_token: 0.000002 } }],
    });
  });
  const usage = await extractNativeAgentSessionUsage({
    vars: {
      ...makeVars(),
      machine: 'producing-node',
      machineEnv: { LITELLM_URL: 'http://wrong.invalid' },
      projectName: 'fixture',
    },
    runner: 'pi',
    runnerSessionId: 'conversation',
    nativeSession: { sessionId: 'host', ownerPrincipalId: 'owner', executionNodeId: 'owning-node' },
  });
  assert.equal(usage.source, 'runner-transcript');
  assert.equal(poolReads.at(-1), 'owning-node');
  assert.deepEqual(urls, ['http://owning-pool.invalid/v1/model/info']);
  const request = JSON.parse(calls.at(-1)!.argv.at(-2)!)[0];
  assert.equal(request.liteLlmPrices[0][1].input, 2);
  assert.ok(!calls.at(-1)!.argv.join(' ').includes('synthetic-key'));
});

for (const runner of ['pi', 'claude', 'codex']) {
  test(`native ${runner} accounting expands unrelated domain placeholders before reading usage`, async (t) => {
    returnedSession = 'conversation';
    const previousProject = projectJson;
    projectJson = {
      reference_repos: {
        trading_library: { repo_url: 'https://example.invalid/library.git', local_name: 'recipes' },
      },
      vars: { library_label: '{{domain}}-{{slot_id}}' },
      command_env: {
        unset: ['LITELLM_URL', 'LITELLM_BASE_URL', 'LITELLM_API_KEY'],
        domains: {
          trading: {
            set: {
              RECIPE_LIBRARY_PATH: 'trading={{trading_library_repo}}',
              LIBRARY_CONTEXT: '{{library_label}}:{{runtime_dir}}:{{repo}}:{{port}}',
            },
          },
        },
      },
    };
    t.after(() => {
      projectJson = previousProject;
    });
    const before = calls.length;
    const usage = await extractNativeAgentSessionUsage({
      vars: makeVars({ projectName: 'fixture', domain: 'trading' }),
      runner,
      runnerSessionId: 'conversation',
      nativeSession: {
        sessionId: 'host',
        ownerPrincipalId: 'owner',
        executionNodeId: 'owning-node',
      },
    });
    assert.equal(usage.source, 'runner-transcript', usage.error);
    assert.equal(usage.totalTokens, 30);
    assert.equal(usage.costUsd, 0.1);
    assert.equal(calls.length, before + 1);
    const minimalUsage = await extractNativeAgentSessionUsage({
      vars: { slotId: 'retained-slot', remoteRepo: '', projectName: 'fixture', domain: 'trading' },
      runner,
      runnerSessionId: 'conversation',
      nativeSession: {
        sessionId: 'host',
        ownerPrincipalId: 'owner',
        executionNodeId: 'owning-node',
      },
    });
    assert.equal(minimalUsage.source, 'runner-transcript', minimalUsage.error);
    assert.equal(minimalUsage.totalTokens, 30);
    assert.equal(minimalUsage.costUsd, 0.1);
    assert.equal(slotReads.at(-1), 'retained-slot');
  });
}

test('retained native accounting with literal domain settings does not require a registered slot', async (t) => {
  returnedSession = 'conversation';
  const previousProject = projectJson;
  projectJson = {
    command_env: {
      unset: ['LITELLM_URL', 'LITELLM_BASE_URL', 'LITELLM_API_KEY'],
      domains: { trading: { set: { RECIPE_LIBRARY_PATH: 'trading=/frozen/library' } } },
    },
  };
  t.after(() => {
    projectJson = previousProject;
  });
  const before = slotReads.length;
  const usage = await extractNativeAgentSessionUsage({
    vars: { slotId: 'removed-slot', remoteRepo: '', projectName: 'fixture', domain: 'trading' },
    runner: 'pi',
    runnerSessionId: 'conversation',
    nativeSession: { sessionId: 'host', ownerPrincipalId: 'owner', executionNodeId: 'owning-node' },
  });
  assert.equal(usage.source, 'runner-transcript', usage.error);
  assert.equal(usage.totalTokens, 30);
  assert.equal(slotReads.length, before);
});
