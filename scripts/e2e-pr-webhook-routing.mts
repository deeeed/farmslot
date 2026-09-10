#!/usr/bin/env tsx
// Exercise the production HTTP handler and real GitHub reads in an isolated state root.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const login = process.env.RULE_GITHUB_LOGIN;
const repo = process.env.RULE_REPOSITORY;
const number = Number(process.env.RULE_PR_NUMBER);
assert(
  login && repo && Number.isSafeInteger(number) && number > 0,
  'Set RULE_GITHUB_LOGIN, RULE_REPOSITORY and RULE_PR_NUMBER to a readable existing PR',
);
const root = await mkdtemp(join(tmpdir(), 'farmslot-webhook-proof-'));
const secret = randomUUID();
let close: (() => Promise<void>) | undefined;
try {
  for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
    const target = join(root, marker);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, marker.endsWith('.json') ? '{}' : 'isolated validation root');
  }
  await mkdir(join(root, 'projects', 'validation'), { recursive: true });
  await writeFile(
    join(root, 'projects', 'validation', 'project.json'),
    JSON.stringify({
      name: 'validation',
      ci: { repo },
      webhooks: { github_secret: secret, auto_dispatch: false },
    }),
  );
  process.env.FARMSLOT_ROOT = root;
  const { PRRuleStore } = await import('../services/gateway/src/pr-rules/store.js');
  const { PRRuleService } = await import('../services/gateway/src/pr-rules/service.js');
  const { handleGitHubWebhook, setGitHubRuleEventRouter } =
    await import('../services/gateway/src/webhook.js');
  const { getQueueSnapshot } = await import('../services/gateway/src/backlog/dispatch-queue.js');
  const store = await PRRuleStore.load(join(root, 'rules.json'));
  const service = new PRRuleService(
    store,
    () => true,
    () => {},
  );
  const predicate = {
    kind: 'compare' as const,
    field: 'state' as const,
    operator: 'equals' as const,
    value: 'open',
  };
  const team = await store.saveTeam('validation', {
    name: 'Project routing validation',
    account: { host: 'github.com', login },
    sources: [
      {
        kind: 'github-project',
        projectId: 'PVT_unavailable_validation_project',
        label: 'Unavailable validation project',
      },
    ],
    predicate,
    repositories: [],
    githubTeams: [],
    notificationPrincipalIds: [],
  });
  let rule = await store.saveRule('validation', {
    name: 'Project routing validation',
    teamId: team.id,
    predicate,
    actions: [{ kind: 'notify' }],
    pollIntervalMs: 300000,
    maxAdmissionsPerScan: 1,
    rereviewOnHeadChange: false,
  });
  rule = await store.setEnabled('validation', rule.id, rule.revision, true, false);
  setGitHubRuleEventRouter((pr) => service.routeWebhook(pr));
  const server = createServer((req, res) => {
    void handleGitHubWebhook(req, res, () => null).catch((error: unknown) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  const address = server.address();
  assert(address && typeof address === 'object');
  const send = async (prNumber: number) => {
    const body = JSON.stringify({
      repository: { full_name: repo },
      action: 'opened',
      pull_request: { number: prNumber },
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
    });
    return { status: response.status, body: await response.json() };
  };
  // The provider's real NOT_FOUND response must not claim ownership of an unavailable PR.
  const unavailable = await send(2147483647);
  assert.equal(unavailable.status, 200, JSON.stringify(unavailable));
  assert.equal(unavailable.body.reason, 'auto_dispatch disabled');
  // A readable PR with an unavailable Project remains uncertain and asks GitHub to retry.
  const uncertain = await send(number);
  assert.equal(uncertain.status, 503, JSON.stringify(uncertain));
  const repoTeam = await store.saveTeam('validation', {
    ...team.config,
    name: 'Repository routing validation',
    sources: [{ kind: 'repository', repo }],
  });
  let repoRule = await store.saveRule('validation', { ...rule.config, teamId: repoTeam.id });
  repoRule = await store.setEnabled('validation', repoRule.id, repoRule.revision, true, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const before = store.rule(repoRule.id, 'validation').scan.nextScanAt;
  assert.equal((await send(number)).status, 503);
  assert.notEqual(
    store.rule(repoRule.id, 'validation').scan.nextScanAt,
    before,
    'Known repository source must be scheduled despite another rule uncertainty',
  );
  await store.setEnabled('validation', rule.id, rule.revision, false, false);
  const routed = await send(number);
  assert.equal(routed.status, 200);
  assert.equal(routed.body.routed, 'rules');
  assert.equal(store.snapshot().intents.length, 0);
  assert.equal(getQueueSnapshot().length, 0);
  console.log(
    JSON.stringify({
      passed: true,
      unavailable: 'legacy',
      membershipFailure: 'retry',
      knownSource: 'scheduled',
      admitted: 0,
    }),
  );
} finally {
  if (close) await close();
  await rm(root, { recursive: true, force: true });
}
