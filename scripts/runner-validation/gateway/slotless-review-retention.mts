// Opt-in proof: two real provider turns in an isolated slotless farm. No live farm writes.
import assert from 'node:assert/strict';
import type { Run, RepeatReviewContext } from '@farmslot/protocol';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const repo = process.cwd();
const root = fs.realpathSync(fs.mkdtempSync('/tmp/slotless-review-proof-'));
assert(process.argv[2], 'Pass a new evidence directory outside the private fixture');
const out = path.resolve(process.argv[2]);
assert(!out.startsWith(root + path.sep));
fs.writeFileSync(
  path.join(root, 'proof-owned.json'),
  JSON.stringify({ purpose: 'slotless-review-retention', root }),
);
assert(!fs.existsSync(out), 'Use a new evidence directory');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
for (const directory of [
  'pool',
  'projects/fixture/templates/worker',
  'projects/fixture/fixtures',
  'runs',
  'tmux',
  'upstream',
  'home',
])
  fs.mkdirSync(path.join(root, directory), { recursive: true });
for (const directory of ['scripts', 'packages'])
  fs.symlinkSync(path.join(repo, directory), path.join(root, directory), 'dir');
fs.mkdirSync(path.join(root, 'services/gateway'), { recursive: true });
fs.writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
fs.writeFileSync(
  path.join(root, 'package.json'),
  JSON.stringify({ name: 'farmslot', private: true }),
);
fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated review retention proof\n');
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: '',
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '0',
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  NODE_TEST_CONTEXT: '1',
  TMUX_TMPDIR: path.join(root, 'tmux'),
});
delete process.env.TMUX;
delete process.env.TMUX_PANE;
fs.writeFileSync(
  path.join(root, 'status.json'),
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    slots: [],
    summary: {
      total: 0,
      ready: 0,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  }),
);
const run = (file: string, args: string[], cwd = root) =>
  execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const upstream = path.join(root, 'upstream');
const git = (...args: string[]) => run('git', args, upstream);
git('init');
const commit = (value: string) => {
  fs.writeFileSync(path.join(upstream, 'greeting.txt'), value + '\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'fixture greeting',
  );
  return git('rev-parse', 'HEAD');
};
const base = commit('Hello'),
  firstHead = commit('Hello one'),
  nextHead = commit('Hello two');
git('checkout', '--detach', base);
fs.writeFileSync(path.join(upstream, 'main-only.txt'), 'Independently advanced publication base\n');
git('add', '.');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  'commit',
  '-m',
  'advance publication base',
);
const advancedBase = git('rev-parse', 'HEAD');
const machine = os.hostname().split('.')[0];
fs.writeFileSync(
  path.join(root, 'pool', machine + '.json'),
  JSON.stringify({
    machine,
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'fixture',
    platform: 'cli',
    os: process.platform,
    review_workspaces: { max_concurrent: 2 },
    slots: [],
  }),
);
fs.mkdirSync(path.join(root, 'projects/fixture/fixtures/review-support'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'projects/fixture/fixtures/review-support/skill.md'),
  '# Fixture review\nReview only the greeting literal change and save the required report.\n',
);
fs.writeFileSync(
  path.join(root, 'projects/fixture/project.json'),
  JSON.stringify({
    name: 'fixture',
    repo_url: upstream,
    paths: { runtime_dir: '.agent', artifact_dir: 'artifacts' },
    execution_templates: {},
    static_review: {
      template_id: 'review-pr/default',
      instruction_files: [],
      support: {
        skills: [
          {
            name: 'fixture-review',
            root: { projectPath: 'fixtures/review-support' },
            entry: 'skill.md',
          },
        ],
      },
      workspace: { root: path.join(root, 'external-review-root'), retention_days: 2 },
    },
    monitoring: { total_timeout_min: 5, inactivity_timeout_min: 3 },
  }),
);
fs.writeFileSync(
  path.join(root, 'projects/fixture/templates/worker/review-pr.md'),
  '# Review fixture\n\n- [ ] **1. Inspect the exact diff.** This fixture changes only literal greeting text. Check its bytes.\n- [ ] **2. Write the required review artifacts and complete the review.** Compute reportSha256 from the exact saved review.md bytes with Node crypto, then persist that nonempty digest into review-result.json before mark complete. No other work is requested.\n',
);
const load = (relative: string) => import(pathToFileURL(path.join(repo, relative)).href);
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const owner = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Private review proof' },
  [{ role: 'admin', scope: { kind: 'global' } }],
  'slotless-proof',
);
const credential = auth.writer.issueCredential(owner.id, 'Disposable loopback proof');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
const { createWebSocketServer, initServerGlobals } = await load('services/gateway/src/server.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const { createRun, getRun, updateRun, persistRunNow } = await load(
  'services/gateway/src/runs/store.ts',
);
const { loadProjectVars } = await load('services/gateway/src/core/config.ts');
const { resolveConfiguredExecutionTemplate } = await load(
  'services/gateway/src/tasks/execution-template-catalog.ts',
);
const { readReviewWorkspaceCompletion } = await load(
  'services/gateway/src/review-workspaces/task.ts',
);
const { startRun } = await load('services/gateway/src/run-engine/orchestrator.ts');
const { configureWorkspaceContinuity } = await load(
  'services/gateway/src/review-workspaces/continuity.ts',
);
const { reviewRequestContextForRun } = await load('packages/review-dispatch/src/index.ts');
const { initPRRules } = await load('services/gateway/src/methods/pr-rules.ts');
const { PRMonitorStore } = await load('services/gateway/src/pr-monitoring/store.ts');
const { PRMonitoringService } = await load('services/gateway/src/pr-monitoring/service.ts');
await initPRRules(
  auth,
  () => {},
  false,
  new PRMonitoringService(
    await PRMonitorStore.load(path.join(root, 'monitors.json')),
    () => true,
    () => {},
  ),
);
const server = createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});
const wss = createWebSocketServer(server, auth);
initServerGlobals();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const client = new GatewayClient({
  url: `ws://127.0.0.1:${address.port}/ws`,
  credential: { token: credential.secret },
  timeout: 30000,
});
const summary: Record<string, unknown> = {
  root,
  ownerId: owner.id,
  base,
  firstHead,
  nextHead,
  advancedBase,
  transport: 'tmux',
  model: 'gpt-6.1-sol',
  farmServicesChanged: false,
};
const save = () =>
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(summary, null, 2));
try {
  let prior: Run | undefined;
  for (const [index, head] of [firstHead, nextHead].entries()) {
    const params = {
      flowType: 'review-pr',
      project: 'fixture',
      ticketOrPr: 'example/fixture#42',
      mode: 'autonomous',
      runner: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'low',
      transport: 'tmux',
      reviewMode: index ? 'warm' : 'cold',
      reviewWorkspaceTarget: { machine },
    };
    const created = createRun(params, {
      nativeOwnerPrincipalId: owner.id,
      createdByPrincipalId: owner.id,
    });
    const subject = {
      repository: 'example/fixture',
      repositoryUrl: upstream,
      headSha: head,
      baseSha: index ? firstHead : base,
      contributionBaseSha: index ? advancedBase : base,
      branch: 'fixture',
      title: 'Greeting text fixture',
      body: 'This is a private transport/retention proof. No app, network or publication work.',
      capturedAt: new Date().toISOString(),
    };
    const template = resolveConfiguredExecutionTemplate(await loadProjectVars('fixture'), {
      flow: 'review-pr',
      platform: 'cli',
      runMode: 'autonomous',
    });
    let continuation: RepeatReviewContext | undefined;
    if (prior) {
      const request = reviewRequestContextForRun(prior);
      assert(request);
      updateRun(created.id, { reviewContext: request });
      continuation = {
        version: 1,
        chainId: prior.id,
        generation: 2,
        verdict: 'pass',
        priorRunId: prior.id,
        priorFamilyId: prior.familyId,
        repository: subject.repository,
        prNumber: 42,
        priorReviewedHeadSha: firstHead,
        currentHeadSha: head,
        baseRef: 'main',
        mode: 'warm',
        validationDepth: 'static-code',
        session: prior.reviewResult!.session,
        unresolvedFindings: [],
        artifactRefs: [],
        farmslotEvidenceRefs: [],
      };
      configureWorkspaceContinuity(getRun(created.id), prior, continuation, subject);
    }
    updateRun(created.id, {
      reviewAutoFinish: true,
      executionTemplate: template.reference,
      reviewWorkspaceSubject: subject,
      ...(continuation ? { repeatReviewContext: continuation } : {}),
    });
    await persistRunNow(getRun(created.id), 'private proof frozen Git fixture input');
    console.log('START', index, created.id);
    save();
    await startRun(created.id);
    const observed = await client.call('run.get', { runId: created.id });
    const finished: Run = observed.run;
    fs.writeFileSync(path.join(out, `round-${index + 1}.json`), JSON.stringify(finished, null, 2));
    assert.equal(finished.status, 'done', finished.error);
    assert(finished.reviewWorkspace);
    assert(finished.reviewWorkspaceSubject);
    assert(finished.reviewResult?.session);
    assert(finished.agentContexts?.length);
    assert.equal(finished.slotId, null);
    assert.equal(finished.transport, 'tmux');
    assert(finished.reviewWorkspace.retainedAt);
    assert(finished.reviewWorkspace.executionStoppedAt);
    const reread = await readReviewWorkspaceCompletion(finished.id);
    assert.equal(
      reread?.result?.reviewMd,
      finished.reviewResult.reviewMd,
      'Closed retained review still supports publication/evidence rereads',
    );
    assert(
      finished.reviewWorkspace.support?.path.startsWith(path.join(root, 'external-review-root')),
    );
    const held = spawnSync(
      'tmux',
      ['has-session', '-t', 'review-' + finished.reviewWorkspace.workspaceId],
      { encoding: 'utf8' },
    );
    assert.equal(held.status, 1, 'Completed reviewer terminal is confirmed stopped');
    assert.equal(
      run('git', [
        '-C',
        finished.reviewWorkspace.checkoutPath,
        'rev-parse',
        `refs/reviews/${finished.reviewWorkspace.workspaceId}/contribution-base`,
      ]),
      subject.contributionBaseSha,
    );
    run('git', [
      '-C',
      finished.reviewWorkspace.checkoutPath,
      'diff',
      '--name-status',
      `${subject.contributionBaseSha}...${head}`,
    ]);
    assert(!finished.reviewWorkspace.cleanedAt);
    assert(fs.existsSync(finished.reviewWorkspace.checkoutPath));
    assert(finished.reviewResult.session.sessionId);
    assert.equal(finished.reviewResult.session.lastReviewedHeadSha, head);
    assert.equal(finished.agentContexts.find((c) => c.id === 'review')?.effort, 'low');
    assert.equal(
      fs.readFileSync(path.join(finished.reviewWorkspace.checkoutPath, 'greeting.txt'), 'utf8'),
      index ? 'Hello two\n' : 'Hello one\n',
    );
    if (prior) {
      assert.equal(finished.reviewResult.session.sessionId, prior.reviewResult!.session!.sessionId);
      assert.equal(
        finished.agentContexts[0].runnerSessionPath,
        prior.agentContexts![0].runnerSessionPath,
      );
      assert.equal(finished.reviewResult.session.continuity, 'resumed');
      assert.equal(finished.reviewWorkspaceSubject.baseSha, firstHead);
      assert.equal(
        finished.agentContexts[0].promptAcceptance?.sessionId,
        prior.reviewResult!.session!.sessionId,
      );
      assert.notEqual(finished.reviewWorkspace.checkoutPath, prior.reviewWorkspace!.checkoutPath);
    }
    summary[`round${index + 1}`] = {
      id: finished.id,
      session: finished.reviewResult.session,
      acceptance: finished.agentContexts[0].promptAcceptance,
      cwd: finished.reviewWorkspace.checkoutPath,
      retainedUntil: finished.reviewWorkspace.retainedUntil,
    };
    prior = finished;
    save();
  }
  summary.pass = true;
  save();
} catch (error) {
  summary.error = error instanceof Error ? error.stack : String(error);
  save();
  throw error;
} finally {
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // This socket and every workspace below root belong only to this proof.
  const listed = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
    encoding: 'utf8',
  });
  assert([0, 1].includes(listed.status!));
  if (listed.status === 0)
    for (const name of listed.stdout.trim().split('\n').filter(Boolean))
      run('tmux', ['kill-session', '-t', '=' + name]);
  const hostFile = path.join(root, 'native', 'host.json');
  if (fs.existsSync(hostFile)) {
    const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
    const command = run('ps', ['-p', String(host.pid), '-o', 'command=']);
    assert(command.includes(root));
    process.kill(host.pid, 'SIGTERM');
  }
  summary.cleanupRoot = root;
  save();
}

process.exit(0);
