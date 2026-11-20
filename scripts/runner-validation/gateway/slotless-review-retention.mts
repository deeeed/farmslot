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
const reviewRunner = process.env.FARMSLOT_REVIEW_PROOF_RUNNER ?? 'codex';
const proveReadOnly = process.env.FARMSLOT_REVIEW_PROOF_READ_ONLY === '1';
const proveReferences = process.env.FARMSLOT_REVIEW_PROOF_REFERENCES === '1';
const proveUsage = process.env.FARMSLOT_REVIEW_PROOF_USAGE === '1';
// Opt-in: proves only the remote tmux Pi receipt's LiteLLM pricing, then ends the proof. It binds to
// the route the Pi process used and re-measures through the remote receipt branch.
const proveRemotePricing = process.env.FARMSLOT_REVIEW_PROOF_REMOTE_PRICING === '1';
assert(!proveReadOnly || ['pi', 'cursor', 'opencode', 'grok', 'claude'].includes(reviewRunner));
const reviewModel = process.env.FARMSLOT_REVIEW_PROOF_MODEL ?? 'gpt-6.1-sol';
const reviewTransport = process.env.FARMSLOT_REVIEW_PROOF_TRANSPORT ?? 'tmux';
assert(['tmux', 'native'].includes(reviewTransport));
assert(!proveRemotePricing || (reviewRunner === 'pi' && reviewTransport === 'tmux'));
const reviewEffort =
  process.env.FARMSLOT_REVIEW_PROOF_EFFORT === 'none'
    ? undefined
    : (process.env.FARMSLOT_REVIEW_PROOF_EFFORT ?? 'low');
const rounds = Number(process.env.FARMSLOT_REVIEW_PROOF_ROUNDS ?? '2');
assert([1, 2].includes(rounds));
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
const reference = path.join(root, 'reference');
if (proveReferences) run('git', ['clone', upstream, reference]);
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
    slots: proveReferences
      ? [{ id: machine + '-fixture', repo: upstream, project: 'fixture', enabled: false }]
      : [],
  }),
);
fs.mkdirSync(path.join(root, 'projects/fixture/fixtures/review-support'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'projects/fixture/fixtures/review-support/skill.md'),
  '# Fixture review\nReview only the greeting literal change and save the required report.\n' +
    (proveReferences
      ? 'Read the frozen reference greeting at ' +
        reference +
        '/greeting.txt through the file-read tool and record its contents in the report.\n'
      : ''),
);
// This prelude executes inside the real worker's sandbox, before the provider starts.
// Static reviewers must not run validation probes or be asked to violate their task contract.
const proofRunner = path.join(root, 'proof-runner');
if (proveReadOnly) {
  const binary = run('/usr/bin/which', [reviewRunner === 'cursor' ? 'cursor-agent' : reviewRunner]);
  const probe = path.join(root, 'read-only-probe.cjs');
  fs.writeFileSync(
    probe,
    `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const source=process.cwd();
if(process.env.TMPDIR===path.join(path.dirname(source),'task/.review-runtime/tmp')&&path.basename(source)==='source'&&source.startsWith(${JSON.stringify(root)}+path.sep)) {
  const file=path.join(source,'greeting.txt'),before=fs.readFileSync(file);let denial;
  try{fs.appendFileSync(file,'WRITE_MUST_BE_DENIED');}catch(error){if(!['EPERM','EACCES','EROFS'].includes(error.code))throw error;denial=error.code;}
  const after=fs.readFileSync(file);
  const result={writeDenied:!!denial,denial,sourceUnchanged:before.equals(after),sha256:crypto.createHash('sha256').update(after).digest('hex')};
  fs.writeFileSync(path.join(path.dirname(source),'task/artifacts/read-only.json'),JSON.stringify(result));
  if(!result.writeDenied||!result.sourceUnchanged)process.exitCode=1;
}
`,
  );
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(
    proofRunner,
    `#!/bin/sh\n${quote(process.execPath)} ${quote(probe)} || exit $?\nexec ${quote(binary)} "$@"\n`,
    { mode: 0o700 },
  );
  const poolPath = path.join(root, 'pool', machine + '.json');
  const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
  pool[reviewRunner === 'cursor' ? 'cursor_path' : reviewRunner + '_path'] = proofRunner;
  fs.writeFileSync(poolPath, JSON.stringify(pool));
}
fs.writeFileSync(
  path.join(root, 'projects/fixture/project.json'),
  JSON.stringify({
    name: 'fixture',
    repo_url: upstream,
    ...(proveReferences ? { reference_repos: { fixture: { local_name: 'reference' } } } : {}),
    paths: { runtime_dir: '.agent', artifact_dir: 'artifacts' },
    execution_templates: {},
    static_review: {
      template_id: 'review-pr/default',
      instruction_files: [],
      support: {
        ...(proveReferences ? { environment: { FIXTURE_REFERENCE: '{{fixture_repo}}' } } : {}),
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
// The node's own home: the remote-pricing proof isolates only the reviewer's Pi home.
const nodeHome = os.homedir();
const proofRoute = proveRemotePricing
  ? await proofLiteLlmRoutes(modelsJsonRoute(reviewModel).baseUrl)
  : undefined;
if (proofRoute) {
  // Before the gateway loads: its local node environment is this process's, read at load time.
  // Pi gets an isolated home whose agent directory's models.json lists the review model on the
  // `route` proxy, with its key read from the environment, never copied. Session recovery reads
  // that same home. Discovery starts on the actual route so Pi can record its request. The
  // gateway receipt is later remeasured with both matching and different pricing endpoints.
  const { id } = modelsJsonRoute(reviewModel);
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(nodeHome, '.pi/agent');
  const real = JSON.parse(fs.readFileSync(path.join(agent, 'models.json'), 'utf8')).providers
    .litellm;
  const {
    baseUrl: _baseUrl,
    headers: _headers,
    apiKey: _apiKey,
    ...model
  } = real.models.find((entry: { id: string }) => entry.id === id);
  const home = path.join(root, 'pi-home');
  const isolated = path.join(home, '.pi/agent');
  fs.mkdirSync(isolated, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(isolated, 'models.json'),
    JSON.stringify({
      providers: {
        litellm: {
          baseUrl: `${proofRoute.route}/v1`,
          api: real.api ?? 'openai-completions',
          apiKey: '$LITELLM_API_KEY',
          models: [model],
        },
      },
    }),
  );
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.LITELLM_URL = proofRoute.route;
  delete process.env.LITELLM_BASE_URL;
  process.env.FARMSLOT_LITELLM_PRICING_CACHE_DIR = path.join(root, 'litellm-prices');
  assert(process.env.LITELLM_API_KEY, 'Gateway LiteLLM credentials');
}
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
const { getRunnerDefinition } = await load('services/gateway/src/runners/registry.ts');
const expectSession =
  rounds === 2 ||
  reviewTransport === 'native' ||
  !!getRunnerDefinition(reviewRunner).sessionContinuation.terminal;
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
  transport: reviewTransport,
  runner: reviewRunner,
  model: reviewModel,
  farmServicesChanged: false,
};
const save = () =>
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(summary, null, 2));
try {
  let prior: Run | undefined;
  for (const [index, head] of [firstHead, nextHead].slice(0, rounds).entries()) {
    const params = {
      flowType: 'review-pr',
      project: 'fixture',
      ticketOrPr: 'example/fixture#42',
      mode: 'autonomous',
      runner: reviewRunner,
      model: reviewModel,
      effort: reviewEffort,
      transport: reviewTransport,
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
    const template = await resolveConfiguredExecutionTemplate(await loadProjectVars('fixture'), {
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
    if (proofRoute) {
      // This opt-in proof ends here: the retention and session checks belong to the default proof.
      summary.proof = 'remote-pricing';
      summary.remotePricing = await proveRemoteRequestPricing(finished, observed, proofRoute);
      save();
      break;
    }
    assert(finished.reviewWorkspace);
    assert(finished.reviewWorkspaceSubject);
    if (proveReferences)
      assert(
        finished.reviewWorkspace.support?.references?.some(
          (r) => !r.missing && r.path === reference,
        ),
      );
    assert(finished.reviewResult);
    if (expectSession) assert(finished.reviewResult.session);
    assert(finished.agentContexts?.length);
    if (proveUsage) {
      const context = finished.agentContexts.find((entry) => entry.id === 'review');
      assert(context?.runnerSessionId, 'Static review binds its native conversation');
      const usage = finished.sessionUsage?.find(
        (entry) =>
          entry.runner === reviewRunner && entry.runnerSessionId === context.runnerSessionId,
      );
      assert(
        usage && usage.totalTokens != null && usage.totalTokens > 0,
        'run.get returns measured review tokens',
      );
      assert(
        usage.costUsd != null && usage.costUsd > 0,
        'run.get returns the priced fixture review cost',
      );
      assert.equal(usage.role, 'review');
      assert.equal(usage.source, 'runner-transcript');
      assert.equal(finished.metrics.runnerSessionId, context.runnerSessionId);
      assert.equal(finished.metrics.costEstimate, usage.costUsd);
      summary.usage = usage;
    }
    if (proveReadOnly) {
      const readonly = JSON.parse(
        fs.readFileSync(path.join(finished.reviewWorkspace.artifactPath, 'read-only.json'), 'utf8'),
      );
      assert.equal(readonly.writeDenied, true);
      assert.equal(readonly.sourceUnchanged, true);
      summary.readOnlyProofs = [
        ...(Array.isArray(summary.readOnlyProofs) ? summary.readOnlyProofs : []),
        readonly,
      ];
    }
    if (proveReferences && reviewRunner === 'opencode') {
      const observation = JSON.parse(
        run('python3', [
          '-c',
          `
import json,os,sqlite3,sys
root=os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share')
db=sqlite3.connect('file:'+os.path.join(root,'opencode/opencode.db')+'?mode=ro',uri=True)
sessions=db.execute('select id from session where directory=?',(sys.argv[1],)).fetchall()
assert len(sessions)==1, 'Expected one exact fixture conversation'
sid=sessions[0][0]
reads=[]
for (raw,) in db.execute('select data from part where session_id=?',(sid,)):
 part=json.loads(raw);state=part.get('state') or {}
 if part.get('type')=='tool' and part.get('tool')=='read' and (state.get('input') or {}).get('filePath')==sys.argv[2]: reads.append(state)
assert any(state.get('status')=='completed' for state in reads), 'Frozen reference file read did not complete'
print(json.dumps({'sessionId':sid,'filePath':sys.argv[2],'status':'completed'}))
`,
          finished.reviewWorkspace.checkoutPath,
          path.join(reference, 'greeting.txt'),
        ]),
      );
      summary.referenceToolRead = observation;
    }
    assert.equal(finished.slotId, null);
    assert.equal(finished.transport, reviewTransport);
    assert(finished.reviewWorkspace.retainedAt);
    assert(finished.reviewWorkspace.executionStoppedAt);
    if (reviewTransport === 'native')
      assert(
        finished.agentContexts[0].nativeSession?.closedAt,
        'Native worker closure is confirmed',
      );
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
    if (expectSession) {
      assert(finished.reviewResult.session?.sessionId);
      assert.equal(finished.reviewResult.session.lastReviewedHeadSha, head);
    }
    assert.equal(finished.agentContexts.find((c) => c.id === 'review')?.effort, reviewEffort);
    assert.equal(
      fs.readFileSync(path.join(finished.reviewWorkspace.checkoutPath, 'greeting.txt'), 'utf8'),
      index ? 'Hello two\n' : 'Hello one\n',
    );
    if (prior) {
      assert(finished.reviewResult.session);
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
  if (proofRoute) {
    proofRoute.proxy.closeAllConnections();
    await new Promise<void>((resolve) => proofRoute.proxy.close(() => resolve()));
  }
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

// ─── Opt-in remote pricing proof ───

/** The review model's models.json route in Pi's agent directory: where the proof proxy forwards. */
function modelsJsonRoute(model: string) {
  const [provider, id] = [model.slice(0, model.indexOf('/')), model.slice(model.indexOf('/') + 1)];
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
  const config = JSON.parse(fs.readFileSync(path.join(agent, 'models.json'), 'utf8'));
  const entry = config.providers[provider];
  const baseUrl: string =
    entry.models?.find((m: { id: string }) => m.id === id)?.baseUrl ?? entry.baseUrl;
  return { provider, id, baseUrl };
}

/**
 * Two loopback LiteLLM routes to the review model's models.json route, recording each path served.
 * Pi sends requests through `route`; the gateway also tries pricing them through `environment`.
 * Each path carries a token standing in for a credential in the URL.
 */
async function proofLiteLlmRoutes(upstream: string) {
  const tokens = { route: 'proof-route-secret-token', environment: 'proof-env-secret-token' };
  const served: string[] = [];
  const target = upstream.replace(/\/+$/, '').replace(/\/v1$/, '');
  const proxy = createServer(async (req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    const [label, token] =
      Object.entries(tokens).find(([, value]) => pathname.startsWith(`/${value}/v1/`)) ?? [];
    assert(label && token, 'Only the proof routes are served');
    served.push(`${req.method} ${label} ${pathname.slice(token.length + 1)}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(
        ([name]) => !['host', 'connection', 'content-length'].includes(name),
      ),
    ) as Record<string, string>;
    const response = await fetch(target + (req.url ?? '').slice(token.length + 1), {
      method: req.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    res.writeHead(
      response.status,
      Object.fromEntries(
        [...response.headers].filter(
          ([name]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(name),
        ),
      ),
    );
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    route: `${base}/${tokens.route}`,
    environment: `${base}/${tokens.environment}`,
    tokens: Object.values(tokens),
    upstream,
    served,
    proxy,
  };
}

/** Every piece of a URL that could carry a credential or name the endpoint. */
function urlParts(value: string) {
  const url = new URL(value);
  return [url.host, url.username, url.password, url.search.slice(1), url.hash.slice(1)]
    .concat(url.pathname.split('/'))
    .filter((part) => part.length >= 4 && part !== 'v1');
}

/**
 * The live review's receipt measured again through the production remote tmux receipt branch. The
 * node's commands run here, without LiteLLM credentials, with this checkout's CLI on PATH.
 */
async function remoteReceipt(
  finished: Run,
  sessionId: string,
  gatewayEndpoint: string | undefined,
) {
  const remote = 'proof-remote';
  fs.writeFileSync(
    path.join(root, 'pool', remote + '.json'),
    JSON.stringify({
      machine: remote,
      host: remote + '.invalid',
      ssh_user: os.userInfo().username,
      project: 'fixture',
      platform: 'cli',
      os: process.platform,
      slots: [],
      ...(gatewayEndpoint ? { env: { LITELLM_URL: gatewayEndpoint } } : {}),
    }),
  );
  const current = getRun(finished.id);
  updateRun(finished.id, {
    reviewWorkspace: { ...current.reviewWorkspace, machine: remote },
    // The settled receipt is read again only when its measurement predates its completion.
    sessionUsage: current.sessionUsage.map((row: Run['sessionUsage'][number]) =>
      row.runnerSessionId === sessionId ? { ...row, measuredAt: '1970-01-01T00:00:00.000Z' } : row,
    ),
  });
  const bin = path.join(root, 'remote-bin');
  fs.mkdirSync(bin, { recursive: true });
  if (!fs.existsSync(path.join(bin, 'farmslot')))
    fs.symlinkSync(path.join(repo, 'packages/cli/bin/farmslot.mjs'), path.join(bin, 'farmslot'));
  const { captureRunSessionUsage } = await load(
    'services/gateway/src/runtime/agent-session-usage.ts',
  );
  const { withSlotCommandExecutor } = await load('services/gateway/src/core/exec-scope.ts');
  const { parseSessionUsageOutput } = await load(
    'services/gateway/src/runtime/session-usage-result.ts',
  );
  const commands: Array<{
    command: string;
    stdout: string;
    status: number | null;
    stderr: string;
  }> = [];
  await withSlotCommandExecutor(
    async (vars: { host: string }, command: string) => {
      assert.equal(vars.host, remote + '.invalid');
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('LITELLM')),
      );
      const result = spawnSync('/bin/bash', ['-c', command], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...env,
          HOME: nodeHome,
          TSX_TSCONFIG_PATH: path.join(repo, 'services/gateway/tsconfig.json'),
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          NODE_OPTIONS: `--import=${pathToFileURL(path.join(repo, 'node_modules/tsx/dist/esm/index.mjs')).href}`,
        },
      });
      commands.push({
        command,
        stdout: result.stdout,
        status: result.status,
        stderr: result.stderr,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
    },
    () => captureRunSessionUsage(finished.id),
  );
  updateRun(finished.id, { reviewWorkspace: { ...getRun(finished.id).reviewWorkspace, machine } });
  const receipt = getRun(finished.id).sessionUsage.find(
    (row: Run['sessionUsage'][number]) => row.runnerSessionId === sessionId,
  );
  const usage = commands.filter(({ command }) => command.includes('runSessionUsage'));
  assert.equal(usage.length, 1, 'One remote receipt command');
  assert.equal(usage[0].status, 0, usage[0].stderr.slice(0, 500));
  // This measurement as the node reported it, and the stored row: with equal token totals the
  // newest measurement of the same conversation replaces it (preferSessionUsage).
  const measured = parseSessionUsageOutput(usage[0].stdout);
  return {
    routePricesSent: usage[0].command.includes('"liteLlmRoute":{'),
    totalTokens: measured.totalTokens,
    costUsd: measured.costUsd,
    costReason: measured.costReason,
    storedTotalTokens: receipt.totalTokens,
    storedCostUsd: receipt.costUsd,
    source: receipt.source,
  };
}
/**
 * The opt-in remote pricing proof binds the successful Pi requests to assistant transcript entries.
 * The remote receipt branch quotes matching gateway prices and preserves tokens without prices.
 */
async function proveRemoteRequestPricing(
  finished: Run,
  observed: unknown,
  proofRoute: Awaited<ReturnType<typeof proofLiteLlmRoutes>>,
) {
  const { liteLlmEndpointId } = (await load('packages/agent-runtime/scripts/litellm-endpoint.cjs'))
    .default;
  const context = finished.agentContexts!.find((entry) => entry.id === 'review');
  assert(context?.runnerSessionId, 'Static review binds its native conversation');
  const usage = finished.sessionUsage?.find(
    (entry) => entry.runner === reviewRunner && entry.runnerSessionId === context.runnerSessionId,
  );
  assert(usage && usage.totalTokens != null && usage.totalTokens > 0, 'Measured review tokens');
  assert(usage.costUsd != null && usage.costUsd > 0, 'The gateway priced the local receipt');
  summary.usage = usage;
  // Check the request path independently of the receipt's gateway price lookup.
  assert(proofRoute);
  summary.proofRouteRequests = [...proofRoute.served];
  save();
  const id = reviewModel.slice(reviewModel.indexOf('/') + 1);
  assert(
    proofRoute.served.includes('POST route /v1/chat/completions'),
    'Pi sent its review requests through its models.json route',
  );
  assert(
    !proofRoute.served.includes('POST environment /v1/chat/completions'),
    'Pi sent no review request through the alternate pricing endpoint',
  );
  const expected = liteLlmEndpointId(proofRoute.route);
  assert(expected && expected !== liteLlmEndpointId(proofRoute.environment));
  const marker = fs.readFileSync(
    path.join(finished.reviewWorkspace!.taskPath, '.terminal-launch.json'),
    'utf8',
  );
  const transcript = fs
    .readFileSync(context.runnerSessionPath!, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const replies = transcript.filter(
    (entry) => entry.type === 'message' && entry.message?.role === 'assistant',
  );
  assert(replies.length, 'Pi answered');
  const requests = new Map(
    transcript
      .filter((entry) => entry.type === 'custom' && entry.customType === 'farmslot-model-request')
      .map((entry) => [entry.id, entry.data]),
  );
  let boundReplies = 0;
  for (const entry of replies) {
    assert.equal(entry.message.provider, 'litellm', 'Pi used the LiteLLM provider');
    assert.equal(entry.message.model, id);
    if (!entry.message.usage?.totalTokens) continue;
    assert(
      ['stop', 'length', 'toolUse'].includes(entry.message.stopReason),
      'Measured replies completed successfully',
    );
    const request = requests.get(entry.parentId);
    assert.equal(request?.provider, entry.message.provider, 'request provider matches reply');
    assert.equal(request?.model, entry.message.model, 'request model matches reply');
    assert.equal(request?.endpoint, expected, 'reply answers a request on the verified route');
    boundReplies++;
  }
  assert(boundReplies > 0, 'At least one measured reply has a verified request');
  // Neither the persisted run, its run.get reply nor the launch receipt names either URL.
  const persisted = fs.readFileSync(path.join(root, 'runs', finished.id + '.json'), 'utf8');
  for (const part of [
    ...proofRoute.tokens,
    ...urlParts(proofRoute.route),
    ...urlParts(proofRoute.upstream),
  ])
    for (const [name, text] of [
      ['run.get', JSON.stringify(observed)],
      ['run file', persisted],
      ['launch receipt', marker],
      ['request entries', JSON.stringify([...requests.values()])],
    ])
      assert.equal(text.includes(part), false, `${name} exposes a route URL part`);
  // The gateway prices from the verified route, set through the node's pool environment.
  const matched = await remoteReceipt(finished, context.runnerSessionId, proofRoute.route);
  assert.equal(matched.routePricesSent, true, 'Gateway sends endpoint-bound prices');
  assert.equal(matched.source, 'runner-transcript');
  assert.equal(matched.totalTokens, usage.totalTokens);
  assert(matched.costUsd != null && matched.costUsd > 0, 'Remote receipt is priced');
  assert.equal(matched.costUsd, usage.costUsd, 'Quoted from the same gateway price list');
  const unverified = await remoteReceipt(
    finished,
    context.runnerSessionId,
    // The alternate pricing endpoint is not the route Pi used.
    proofRoute.environment,
  );
  assert.equal(unverified.routePricesSent, true, 'Alternate prices exercise node-side matching');
  assert.equal(unverified.source, 'runner-transcript');
  assert.equal(unverified.totalTokens, usage.totalTokens, 'Fallback keeps token counts');
  assert.equal(unverified.costUsd, null, 'The credential-less node leaves it unpriced');
  assert.equal(unverified.storedTotalTokens, usage.totalTokens);
  assert.equal(unverified.storedCostUsd, null, 'run.get reports it unpriced, not guessed');
  return {
    verifiedRequestEndpointId: expected,
    proofRouteRequests: proofRoute.served,
    piProviderReplies: replies.length,
    boundReplies,
    matched,
    unverified,
  };
}

process.exit(0);
