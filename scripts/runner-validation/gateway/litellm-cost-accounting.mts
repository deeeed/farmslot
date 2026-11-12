// Synthetic prices and transcripts, with real native extraction and authenticated run.get.
// No provider inference, occupied slots, or operator gateway writes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Run, RunGetResult, RunnerSessionUsage } from '@farmslot/protocol';

import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';
import {
  cleanupOnExit,
  connectGateway,
  freePort,
  startReaper,
  startWorkspaceProcess,
  stopProcess,
  writeJson,
} from '../lib/isolated-stack.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
assert(process.argv[2], 'Pass a new private evidence directory');
const evidence = path.resolve(process.argv[2]);
await mkdir(evidence, { mode: 0o700 });
const fixture = await mkdtemp(path.join(os.tmpdir(), 'litellm-cost-proof-'));
const reaper = startReaper();
reaper.path(fixture);
for (const directory of [
  'home',
  'pool',
  'projects/fixture',
  'runs',
  'tmux',
  'cli/bin',
  'cli/node_modules/@farmslot/slot-config',
])
  await mkdir(path.join(fixture, directory), { recursive: true });
await mkdir(path.join(fixture, 'services/gateway'), { recursive: true });
await writeJson(path.join(fixture, 'services/gateway/package.json'), {});
await writeJson(path.join(fixture, 'package.json'), { name: 'farmslot', private: true });
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated cost proof\n');
for (const directory of ['scripts', 'packages'])
  await symlink(path.join(root, directory), path.join(fixture, directory));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  FARMSLOT_ROOT: fixture,
  TSX_TSCONFIG_PATH: path.join(root, 'services/gateway/tsconfig.json'),
  FARMSLOT_HOME: path.join(fixture, 'home'),
  FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(fixture, 'native'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
  TMUX_TMPDIR: path.join(fixture, 'tmux'),
  LITELLM_URL: '',
  LITELLM_BASE_URL: '',
  LITELLM_API_KEY: '',
  PATH: path.join(fixture, 'cli/bin') + path.delimiter + process.env.PATH,
};
delete env.TMUX;
delete env.TMUX_PANE;
Object.assign(process.env, env);
delete process.env.TMUX;
delete process.env.TMUX_PANE;
// Native accounting resolves this fixture CLI, never the machine's installed configuration.
await writeFile(path.join(fixture, 'cli/bin/farmslot'), '#!/bin/false\n', { mode: 0o755 });
await writeJson(path.join(fixture, 'cli/node_modules/@farmslot/slot-config/package.json'), {
  type: 'module',
  exports: './session-usage.ts',
});
await symlink(
  path.join(root, 'packages/slot-config/src/session-usage.ts'),
  path.join(fixture, 'cli/node_modules/@farmslot/slot-config/session-usage.ts'),
);
let gateway: ReturnType<typeof startWorkspaceProcess> | undefined;
let ui: { close(): Promise<void>; listen(): Promise<unknown> } | undefined;
let browserOpen = false;
const browserRoute = 'run/missing-review';
const cdpEnv: NodeJS.ProcessEnv = {
  ...env,
  FARMSLOT_CDP_PORT: process.env.FARMSLOT_CDP_PORT ?? '19222',
  FARMSLOT_UI_URL: 'http://127.0.0.1/',
};
const cdp = (...args: string[]) =>
  promisify(execFile)(
    process.execPath,
    [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
    { env: cdpEnv, timeout: 60000 },
  );
let connection: Awaited<ReturnType<typeof connectGateway>> | undefined;
let prices: ReturnType<typeof createServer> | undefined;
const cleanup = cleanupOnExit(async () => {
  const pricingServer = prices;
  const stopped = await Promise.allSettled([
    ...(browserOpen ? [cdp('close', browserRoute)] : []),
    ui?.close(),
    stopProcess(gateway),
    pricingServer?.listening
      ? new Promise<void>((resolve, reject) =>
          pricingServer.close((error) => (error ? reject(error) : resolve())),
        )
      : Promise.resolve(),
  ]);
  connection?.close();
  await rm(fixture, { recursive: true, force: true });
  reaper.done();
  const failures = stopped.filter((row) => row.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((row) => row.reason),
      'Proof cleanup failed',
    );
});
try {
  let requests = 0;
  prices = createServer((request, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        data: [
          {
            model_name: 'fixture-priced',
            model_info: {
              input_cost_per_token: 0.000002,
              output_cost_per_token: 0.00001,
              cache_read_input_token_cost: 0.0000002,
              cache_creation_input_token_cost: 0.0000025,
            },
          },
        ],
      }),
    );
  }).listen(0, '127.0.0.1');
  await once(prices, 'listening');
  const address = prices.address();
  assert(address && typeof address === 'object');
  const machine = os.hostname().split('.')[0];
  await writeJson(path.join(fixture, `pool/${machine}.json`), {
    machine,
    host: 'localhost',
    ssh_user: 'fixture',
    project: 'fixture',
    platform: 'cli',
    os: process.platform,
    slots: [],
    env: {
      LITELLM_URL: `http://127.0.0.1:${address.port}`,
      LITELLM_API_KEY: 'synthetic-key',
      FARMSLOT_LITELLM_PRICING_CACHE_DIR: path.join(fixture, 'prices'),
    },
  });
  await writeJson(path.join(fixture, 'projects/fixture/project.json'), {
    name: 'fixture',
    command_env: { set: { LITELLM_URL: 'http://wrong-project.invalid' } },
  });
  const now = '2026-01-01T00:00:00Z';
  const receipt = (id: string, role: string, costUsd: number | null): RunnerSessionUsage => ({
    runner: 'pi',
    runnerSessionId: id,
    role,
    source: 'runner-transcript',
    measuredAt: now,
    model: 'fixture-priced',
    totalTokens: 100,
    costUsd,
  });
  const run = (id: string, familyId = id): Run => ({
    id,
    familyId,
    parentRunId: null,
    familyRootTicketOrPr: familyId,
    lane: 'production',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    status: 'done',
    project: 'fixture',
    ticketOrPr: id,
    slotId: null,
    branch: 'fixture',
    taskFile: null,
    steps: [],
    metrics: {
      nudgeCount: 0,
      model: 'fixture-priced',
      runner: 'pi',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: now,
    updatedAt: now,
    decisions: [
      {
        id: `${id}-gate`,
        type: 'engine_human_gate',
        title: 'Fixture cost',
        description: '',
        createdAt: now,
        actions: [],
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          diffStat: { files: 0, additions: 0, deletions: 0 },
          acceptanceCriteria: ['Account for every captured and unavailable session'],
          workerReport: '',
          branch: 'fixture',
          headSha: 'fixture-head',
        },
      },
    ],
  });
  const runs: Run[] = [];
  for (const role of ['review', 'dev']) {
    const entry = run(`missing-${role}`);
    entry.sessionUsage = [
      receipt('priced', role === 'review' ? 'dev' : 'review', 0.25),
      {
        ...receipt('missing', role, null),
        source: 'unavailable',
        totalTokens: null,
        error: 'Fixture node offline',
      },
    ];
    entry.engineState = {
      publishGate: {
        reviews: [
          {
            id: 'pipeline-review-1',
            source: 'pipeline',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'failed',
            unresolvedCount: 0,
            usage: entry.sessionUsage.find((row) => row.role === 'review'),
          },
        ],
      },
    };
    runs.push(entry);
  }
  const earlier = run('warm-earlier', 'warm-family');
  const later = run('warm-later', 'warm-family');
  later.flowType = 'update-branch';
  later.createdAt = '2026-01-02T00:00:00Z';
  for (const [entry, cost] of [
    [earlier, 0.1],
    [later, 0.15],
  ] as const) {
    entry.engineState = {
      publishGate: {
        reviews: [
          {
            id: 'pipeline-review-1',
            source: 'pipeline',
            mode: 'warm',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            usage: receipt('shared-conversation', 'review', cost),
          },
        ],
      },
    };
  }
  runs.push(earlier, later);
  const transcript = path.join(fixture, 'native.jsonl');
  await writeFile(
    transcript,
    [
      { type: 'session', id: 'native-conversation' },
      {
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'litellm',
          model: 'fixture-priced',
          usage: { input: 4, output: 4, cacheRead: 38195, cacheWrite: 0, cost: { total: 0 } },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const { extractNativeAgentSessionUsage } =
    await import('../../../services/gateway/src/runtime/native-session-usage.js');
  const usage = await extractNativeAgentSessionUsage({
    vars: { slotId: 'fixture-native', remoteRepo: fixture, projectName: 'fixture' },
    runner: 'pi',
    runnerSessionId: 'native-conversation',
    runnerSessionPath: transcript,
    nativeSession: {
      sessionId: 'fixture-host',
      ownerPrincipalId: 'fixture-owner',
      executionNodeId: 'local',
    },
  });
  assert.equal(usage.source, 'runner-transcript');
  assert.equal(usage.costUsd, 0.007687);
  assert.equal(requests, 1, 'one metadata read from the owning pool, no inference');
  const native = run('native');
  native.sessionUsage = [{ ...usage, role: 'dev' }];
  runs.push(native);
  for (const entry of runs) await writeJson(path.join(fixture, 'runs', `${entry.id}.json`), entry);
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const token = testGatewayIdentity(path.join(fixture, 'home'));
  gateway = startWorkspaceProcess(
    { root, evidence, env: { ...env, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(port) } },
    '@farmslot/gateway',
    'gateway.log',
  );
  reaper.group(gateway.pid);
  connection = await connectGateway({
    url,
    token,
    gateway,
    log: path.join(evidence, 'gateway.log'),
    budgetMs: 60000,
  });
  const results = [];
  for (const entry of runs) {
    const { run: projected } = await connection.call<RunGetResult>('run.get', { runId: entry.id });
    const payload = projected.decisions[0]?.payload;
    assert(payload?.kind === 'ready' && payload.gateSummary);
    const summary = payload.gateSummary.tokens;
    if (entry.id.startsWith('missing-')) {
      assert.equal(summary.familyCostUsd, null);
      assert.match(summary.familyCostReason ?? '', /unpriced or uncaptured/);
      assert.equal(summary.familyTotalTokens, 100);
    } else if (entry.familyId === 'warm-family') {
      assert.equal(summary.reviewRounds?.[0].costScope, 'shared-session');
      assert.equal(summary.reviewRounds?.[0].costUsd, null);
      if (entry.id === earlier.id) assert.equal(summary.familyCostUsd, 0.15);
    } else assert.equal(summary.familyCostUsd, 0.007687);
    results.push({ runId: entry.id, summary });
  }
  if (process.env.FARMSLOT_COST_PROOF_CDP === '1') {
    const uiPort = await freePort();
    process.env.GATEWAY_PORT = String(port);
    process.env.VITE_PORT = String(uiPort);
    const requireUi = createRequire(path.join(root, 'apps/command-center/ui/package.json'));
    const { createServer: createVite } = await import(requireUi.resolve('vite'));
    ui = await createVite({
      configFile: path.join(root, 'apps/command-center/ui/vite.config.ts'),
      envDir: false,
      server: { host: '127.0.0.1', port: uiPort, strictPort: true },
    });
    await ui.listen();
    const uiUrl = `http://127.0.0.1:${uiPort}/`;
    cdpEnv.FARMSLOT_UI_URL = uiUrl;
    const connect = Buffer.from(JSON.stringify({ url, token })).toString('base64url');
    await cdp('goto', `${uiUrl}#${browserRoute}?connect=${connect}`, '--new');
    browserOpen = true;
    const observed = await cdp(
      'eval',
      browserRoute,
      '--file',
      path.join(root, 'apps/command-center/probes/litellm-family-cost.js'),
    );
    await writeFile(path.join(evidence, 'browser.json'), observed.stdout);
    await cdp(
      'screenshot',
      browserRoute,
      path.join(evidence, 'family-cost.png'),
      '--width',
      '1440',
      '--height',
      '2200',
    );
    assert.equal(
      JSON.parse(observed.stdout).pass,
      true,
      'Browser displays the incomplete family cost reason',
    );
  }
  await writeJson(path.join(evidence, 'accounting.json'), { metadataRequests: requests, results });
  console.log(JSON.stringify({ pass: true, runs: results.length, metadataRequests: requests }));
} finally {
  await cleanup();
}
