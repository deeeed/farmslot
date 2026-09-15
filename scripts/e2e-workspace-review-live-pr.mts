#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  parseGitHubPullUrl,
  type PRRulesListResult,
  type PRTeamProfile,
  type Run,
} from '../packages/protocol/src/index.js';
import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayConnection,
} from '../packages/cli/src/gateway-client.js';
import { alive, matchesProcess } from '../packages/agent-runtime/src/native/storage.js';
import { startReviewInterfaceServers } from './e2e-static-review-interface.mjs';

// Explicit operator-selected PR and pack. Provider calls are real; the isolated
// gateway uses farm defaults and normal PR intake, with no publication request.
const [url, packArg, repositoryArg, account, evidenceArg] = process.argv.slice(2);
assert(
  url && packArg && repositoryArg && account && evidenceArg,
  'Usage: e2e-workspace-review-live-pr.mts <PR URL> <pack> <local repository> <account> <evidence>',
);
const pr = parseGitHubPullUrl(url);
assert(pr, 'Expected a GitHub pull request URL');
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(evidenceArg);
const pack = path.resolve(packArg);
const repository = path.resolve(repositoryArg);
const config = JSON.parse(await readFile(path.join(pack, 'project.json'), 'utf8'));
assert(config.static_review?.support, 'The selected farm must declare frozen review support');
assert.equal(config.ci.repo.toLowerCase(), pr.repo.toLowerCase());
await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(path.join(tmpdir(), 'workspace-real-pr-'));
const json = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
};
execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
for (const name of ['scripts', 'services', 'packages', 'node_modules'])
  await symlink(path.join(root, name), path.join(fixture, name));
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated real PR review\n');
const projectRoot = path.join(fixture, 'projects', config.name);
await mkdir(projectRoot, { recursive: true });
for (const entry of await readdir(pack, { withFileTypes: true }))
  if (entry.name !== '.git' && entry.name !== 'project.json')
    await symlink(path.join(pack, entry.name), path.join(projectRoot, entry.name));
const execution = {
  workspacePolicy: { kind: 'exact', machine: 'review-live' },
  transport: 'native',
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'medium' }],
};
await json(path.join(projectRoot, 'project.json'), {
  ...config,
  repo_url: repository,
  workflow_defaults: {
    ...config.workflow_defaults,
    'review-pr': {
      execution,
      review: { validationDepth: 'static-code', scope: 'full', sessionIntent: 'reset' },
    },
  },
});
await json(path.join(fixture, 'pool/review.json'), {
  machine: 'review-live',
  host: 'localhost',
  project: config.name,
  platform: 'cli',
  os: process.platform,
  slots: [],
  review_workspaces: { max_concurrent: 3 },
});
await json(path.join(fixture, '.farm-status.json'), {
  checked_at: new Date().toISOString(),
  slots: [],
});
async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return value;
}
const gatewayPort = await port(),
  uiPort = await port();
const token = randomBytes(32).toString('hex');
const nativeRoot = path.join(fixture, 'home/native-sessions');
const servers = startReviewInterfaceServers({
  root,
  evidence,
  environment: {
    ...process.env,
    FARMSLOT_ROOT: fixture,
    FARMSLOT_HOME: path.join(fixture, 'home'),
    FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
    FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
    FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
    FARMSLOT_NATIVE_STATE_DIR: nativeRoot,
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
    FARMSLOT_GATEWAY_TOKEN: token,
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(gatewayPort),
    VITE_PORT: String(uiPort),
    FARMSLOT_DISABLE_ORCHESTRATION: '0',
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  },
});
let connection: GatewayConnection | undefined;
let current: Run | undefined;
let failure: unknown;
try {
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${gatewayPort}`,
    timeout: 60_000,
    credential: { token },
  });
  const readyBy = Date.now() + 30_000;
  while (!connection) {
    try {
      connection = await client.connect();
    } catch (error) {
      if (!(error instanceof GatewayConnectionError) || Date.now() >= readyBy) throw error;
      await delay(200);
    }
  }
  const { team } = await connection.call<{ team: PRTeamProfile }>('prRules.teamSave', {
    config: {
      name: 'Workspace review validation',
      account: { host: 'github.com', login: account },
      sources: [{ kind: 'repository', repo: pr.repo }],
      predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
      repositories: [
        { repo: pr.repo, project: config.name, reviewProfile: 'static', excludedLabels: [] },
      ],
      githubTeams: [],
      notificationPrincipalIds: [],
    },
  });
  await connection.call('prReview.submit', {
    request: {
      teamId: team.id,
      pr: { host: 'github.com', repo: pr.repo, number: pr.number },
      idempotencyKey: randomUUID(),
      autoStart: true,
      source: { client: 'cli' },
    },
  });
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const intake = await connection.call<PRRulesListResult>('prRules.list');
    await json(path.join(evidence, 'intake.json'), intake);
    const intent = intake.intents.find(
      (entry) => entry.pr.repo === pr.repo && entry.pr.number === pr.number,
    );
    if (intent?.status === 'needs-configuration')
      throw new Error(
        JSON.stringify(intent.contributions.map((entry) => entry.configurationErrors)),
      );
    if (intent?.runId) {
      current = (await connection.call<{ run: Run }>('run.get', { runId: intent.runId })).run;
      await json(path.join(evidence, 'run.json'), current);
      if (['done', 'failed', 'blocked', 'cancelled'].includes(current.status)) break;
    }
    await delay(1000);
  }
  assert.equal(current?.status, 'done', current?.error ?? 'PR intake did not complete its review');
  assert.equal(current.slotId, null);
  assert(current.reviewWorkspace?.support?.sha256);
  assert(current.reviewResult?.reviewMd);
  assert.equal(current.reviewResult.reviewSnapshot?.headSha, current.prWork?.headSha);
  assert(current.reviewWorkspace.cleanedAt);
  await assert.rejects(access(current.reviewWorkspace.checkoutPath));
  await cp(path.dirname(current.taskFile!), path.join(evidence, 'task'), { recursive: true });
  await json(path.join(evidence, 'summary.json'), {
    passed: true,
    url,
    runId: current.id,
    headSha: current.prWork?.headSha,
    support: current.reviewWorkspace.support,
    slotId: null,
    published: false,
  });
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), {
    error: String(error),
    fixture,
    runId: current?.id,
  });
} finally {
  try {
    if (connection) {
      const listed = await connection.call<{ runs: Run[] }>('run.list', { limit: 100 });
      for (const run of listed.runs.filter((entry) => entry.status !== 'done')) {
        const cancelled = await connection.call<{ effects: Array<{ status: string }> }>(
          'run.cancel',
          { runId: run.id, reason: 'Isolated real PR review cleanup' },
        );
        if (cancelled.effects.some((effect) => effect.status === 'failed'))
          throw new Error('Real review cleanup is incomplete');
      }
    }
  } catch (error) {
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      'Review or cleanup failed',
    );
  }
  connection?.close();
  try {
    const host = JSON.parse(await readFile(path.join(nativeRoot, 'host.json'), 'utf8'));
    if (alive(host.pid)) {
      assert(matchesProcess(host.pid, nativeRoot));
      process.kill(host.pid, 'SIGTERM');
      const deadline = Date.now() + 10_000;
      while (alive(host.pid) && Date.now() < deadline) await delay(100);
      assert(!alive(host.pid), 'Owned native supervisor did not stop');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      failure = new AggregateError([...(failure ? [failure] : []), error], 'Native cleanup failed');
  } finally {
    try {
      await servers.stop();
    } catch (error) {
      failure = new AggregateError([...(failure ? [failure] : []), error], 'Server cleanup failed');
    }
  }
  if (!failure) await rm(fixture, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, url, runId: current?.id, evidence }));
