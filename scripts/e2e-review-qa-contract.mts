#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  GatewayClient,
  GatewayConnectionError,
  GatewayRpcError,
  type GatewayConnection,
} from '../packages/cli/src/gateway-client.js';
import type {
  ConfigProjectResult,
  PRReviewRequestResult,
  PRRulesListResult,
  PRTeamProfile,
  PRTriggerRule,
  PRRulePreview,
  PRReviewIntent,
  DispatchQueueAddResult,
  DispatchQueueListResult,
} from '../packages/protocol/src/index.js';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
} from '../packages/recipe-harness/src/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scenario = process.argv[2];
const publicationCase = process.argv[4] ?? 'pass';
if (scenario === 'publication-delivery')
  assert(
    [
      'pass',
      'stale',
      'revoked',
      'lost-response',
      'rejected',
      'concurrent',
      'concurrent-tick',
    ].includes(publicationCase),
    'Unknown publication case',
  );
if (scenario === 'recipe') {
  const catalog = JSON.parse(
    await readFile(
      path.join(root, 'docs/examples/recipes/farmslot-v1.action-manifest.json'),
      'utf8',
    ),
  );
  const actionNames = ['command', 'end'];
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: catalog.$schema,
      actions: Object.fromEntries(actionNames.map((name) => [name, catalog.actions[name]])),
    },
    adapters: createStandardCoreAdapters({ actions: actionNames }),
    runner: {
      source: 'worktree',
      git_ref: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      name: 'Review/QA gateway contract validation',
    },
  });
  const result = await runner.run({
    recipeDocument: JSON.parse(
      await readFile(
        path.join(root, 'docs/examples/recipes/farmslot/review-qa-contract.recipe.json'),
        'utf8',
      ),
    ),
    artifactsDir: path.resolve(root, process.argv[3] ?? `temp/review-qa-contract/${Date.now()}`),
    projectRoot: root,
    source: { kind: 'operator', trust: 'trusted', name: 'Review/QA gateway contract validation' },
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === 'pass' ? 0 : 1);
}
assert(
  [
    'profiles',
    'qa-pool',
    'publication-defaults',
    'publication-accounts',
    'publication-direct',
    'publication-delivery',
    'legacy-queue',
    'legacy-plan-repair',
    'ready-gate-refusal',
    'conflicts',
    'legacy-completed',
    'legacy-pending',
    'approved-qa',
    'bare-pr',
    'linked-qa',
    'automatic-qa',
  ].includes(scenario),
  'Expected profiles, legacy-queue or conflicts',
);
const fixture = await mkdtemp(path.join(tmpdir(), 'farmslot-review-qa-'));
// Reuse existing objects without creating commits or checking out another copy of the source.
execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
const log = path.join(fixture, 'gateway.log');
const token = randomBytes(32).toString('hex');
const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = (portProbe.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  portProbe.close((error) => (error ? reject(error) : resolve())),
);

async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
}

for (const name of ['scripts', 'services', 'packages'])
  await symlink(path.join(root, name), path.join(fixture, name));
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated gateway contract validation\n');
await mkdir(path.join(fixture, 'pool'));
await mkdir(path.join(fixture, 'repo'));
for (const [name, profile] of [
  ['first', 'changes'],
  ['second', 'candidate'],
]) {
  const project = path.join(fixture, 'projects', name);
  await mkdir(path.join(project, 'shared', 'validation'), { recursive: true });
  await writeFile(
    path.join(project, 'shared', 'validation', 'shared.md'),
    '---\nplatforms: [cli]\n---\n\n# Shared validation\n\n- [ ] Execute the selected runtime proof.\n',
  );
  await mkdir(path.join(project, 'shared', 'review-pr'));
  await writeFile(
    path.join(project, 'shared', 'review-pr', 'shared.md'),
    '---\nplatforms: [cli]\n---\n\n# Shared static review\n\n- [ ] Inspect the frozen changes.\n',
  );
  if (scenario === 'legacy-plan-repair') {
    await mkdir(path.join(project, 'shared', 'dev'));
    await writeFile(
      path.join(project, 'shared', 'dev', 'shared.md'),
      '---\nplatforms: [cli]\n---\n\n# Shared development\n\n- [ ] Implement the change.\n',
    );
  }
  await json(path.join(project, 'project.json'), {
    name,
    default_branch: 'main',
    ci: { repo: 'example/app' },
    ...([
      'publication-defaults',
      'publication-delivery',
      'publication-accounts',
      'publication-direct',
    ].includes(scenario)
      ? {
          repo_url: 'https://github.com/example/app.git',
          static_review: { template_id: 'review-pr/shared' },
        }
      : {}),
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    ...([
      'publication-defaults',
      'publication-delivery',
      'publication-accounts',
      'publication-direct',
    ].includes(scenario)
      ? {
          workflow_defaults: {
            'review-pr': { review: { sessionIntent: 'reset', scope: 'full', publishReview: true } },
          },
        }
      : {}),
    ...(scenario === 'approved-qa'
      ? {
          workflow_defaults: {
            qa: {
              review: {
                workflow: 'qa',
                sessionIntent: 'reset',
                scope: 'full',
                qaInputs: { domain: 'fixture-default' },
              },
            },
          },
        }
      : {}),
    ...(scenario === 'qa-pool'
      ? {
          workflow_defaults: {
            qa: {
              execution: {
                slotPolicy: { kind: 'pool', allowedSlots: [`${name}-disabled`, `${name}-other`] },
                models: [{ runner: 'codex', model: 'gpt-5.6-luna', effort: 'low' }],
              },
            },
          },
        }
      : {}),
    execution_templates: {
      sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
    },
    qa: {
      default_profile: profile,
      profiles: [
        {
          id: profile,
          title: `Validate ${profile}`,
          template_id: 'validation/shared',
          inputs: { scope: { kind: profile } },
        },
      ],
    },
  });
  await json(path.join(fixture, 'pool', `${name}.json`), {
    machine: `${name}-node`,
    ...([
      'publication-defaults',
      'publication-delivery',
      'publication-accounts',
      'publication-direct',
    ].includes(scenario)
      ? { review_workspaces: { max_concurrent: 1 } }
      : {}),
    host: 'localhost',
    project: name,
    platform: 'cli',
    os: process.platform,
    slots: [
      {
        id: `${name}-disabled`,
        enabled: false,
        repo: path.join(fixture, 'repo'),
        session: `qa-${name}`,
        resources: {},
      },
      ...(scenario === 'qa-pool'
        ? [
            {
              id: `${name}-other`,
              enabled: false,
              repo: path.join(fixture, 'repo'),
              session: `qa-${name}-other`,
              resources: {},
            },
          ]
        : []),
    ],
  });
}

// Provider fixture only: the gateway still executes its real gh transport, parsing,
// account validation, preview, durable intake and authorization paths. Unknown gh
// commands fail, so this fixture cannot publish or silently call a real provider.
await mkdir(path.join(fixture, 'bin'));
await writeFile(
  path.join(fixture, 'bin', 'gh'),
  String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'token') { process.stdout.write(args.includes('other-publisher') ? 'fixture-other-token\n' : 'fixture-provider-token\n'); process.exit(0); }
const fs = require('node:fs');
let body;
if (args[0] === 'api' && args.includes('user')) body = { login: process.env.GH_TOKEN === 'fixture-other-token' ? 'other-publisher' : 'fixture-reviewer' };
else if (args[0] === 'api' && args.includes('graphql')) {
  const query = args.find(arg => arg.startsWith('query=')) || '';
  if (!query.startsWith('query=query(') || !query.includes('pullRequest') && !query.includes('... on PullRequest')) throw new Error('Unsupported fixture GraphQL operation');
  const pr = { id:'fixture-pr',number:42,title:'Fixture change',state:'OPEN',isDraft:false,
    headRefOid:'a'.repeat(40),baseRefOid:'b'.repeat(40),baseRefName:'main',headRefName:'fixture-change',
    author:{login:'fixture-author'},repository:{nameWithOwner:'example/app'},
    reviewDecision:${scenario === 'approved-qa' ? "'APPROVED'" : 'null'}, viewerLatestReview:null,viewerLatestReviewRequest:null,
    labels:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}} };
  body = {data:{...(query.includes('node(id:') ? {node:pr} : {repository:query.includes('pullRequests(')
    ? {pullRequests:{nodes:[pr],pageInfo:{hasNextPage:false,endCursor:null}}} : {pullRequest:pr}}),
    rateLimit:{cost:1,remaining:4999,resetAt:'2099-01-01T00:00:00Z'}}};
} else if (args[0] === 'api' && args.some(arg => arg.startsWith('repos/example/app/pulls/42'))) {
  const file = process.env.FARMSLOT_TEST_PUBLICATION_STATE;
  if (!file || !fs.existsSync(file)) throw new Error('Publication fixture not enabled');
  const state = JSON.parse(fs.readFileSync(file,'utf8'));
  const endpoint = args.find(arg => arg.startsWith('repos/'));
  if (endpoint.endsWith('/reviews?per_page=100')) body = [state.reviews];
  else if (endpoint.endsWith('/reviews') && args.includes('POST')) {
    if (process.env.GH_TOKEN !== (state.publisher === 'other-publisher' ? 'fixture-other-token' : 'fixture-provider-token')) throw new Error('Publication account not bound');
    const payload = JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1],'utf8'));
    body = { id:77,commit_id:payload.commit_id,body:payload.body,user:{login:state.publisher ?? 'fixture-reviewer'},state:{APPROVE:'APPROVED',REQUEST_CHANGES:'CHANGES_REQUESTED',COMMENT:'COMMENTED'}[payload.event],submitted_at:new Date().toISOString(),html_url:'https://github.com/example/app/pull/42#pullrequestreview-77' };
    state.posts++;state.payload=payload;
    if (state.holdPost) {
      state.postingStarted=true;fs.writeFileSync(file,JSON.stringify(state));
      const deadline=Date.now()+45000;
      while(JSON.parse(fs.readFileSync(file,'utf8')).holdPost && Date.now()<deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
      if(JSON.parse(fs.readFileSync(file,'utf8')).holdPost) throw new Error('Fixture publication release timed out');
    }

    if (state.rejectPost) {
      fs.writeFileSync(file,JSON.stringify(state));
      process.stdout.write('HTTP/2.0 422 Unprocessable Entity\r\ncontent-type: application/json\r\n\r\n'+JSON.stringify({message:'Validation failed'}));
      process.exit(1);
    }
    state.reviews.push(body);fs.writeFileSync(file,JSON.stringify(state));
    if (state.loseResponse) { process.stderr.write('Fixture lost publication response'); process.exit(1); }
  } else if (endpoint === 'repos/example/app/pulls/42') body={number:42,state:'open',head:{sha:state.head},base:{repo:{full_name:'example/app'}},user:{login:'fixture-author'}};
  else throw new Error('Unsupported publication fixture endpoint');
} else throw new Error('Unsupported fixture gh command');
if (args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify(body));
`,
  { mode: 0o700 },
);

function launchGateway() {
  const output = openSync(log, 'a', 0o600);
  const processHandle = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', output, output],
    env: {
      ...process.env,
      PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}`,
      FARMSLOT_ROOT: fixture,
      ...(scenario === 'publication-direct'
        ? { NODE_TEST_CONTEXT: '1', FARMSLOT_DISABLE_RUN_ENGINE_START: '1' }
        : {}),
      FARMSLOT_HOME: path.join(fixture, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
      FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
      FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_TOKEN: token,
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
      FARMSLOT_DISABLE_ORCHESTRATION: ['automatic-qa', 'publication-delivery'].includes(scenario)
        ? '0'
        : '1',
      FARMSLOT_TEST_PUBLICATION_STATE: path.join(fixture, 'publication-provider.json'),
    },
  });
  closeSync(output);
  return processHandle;
}
if (scenario === 'linked-qa' || scenario === 'automatic-qa') {
  const now = new Date().toISOString();
  for (const [id, owner, head] of [
    ['source-review', 'legacy-env', 'a'],
    ['foreign-review', 'another-owner', 'a'],
    ['stale-review', 'legacy-env', 'c'],
  ]) {
    await json(path.join(fixture, 'runs', id + '.json'), {
      id,
      familyId: id + '-family',
      parentRunId: null,
      familyRootTicketOrPr: 'example/app#42',
      lane: 'production',
      variant: null,
      flowType: 'review-pr',
      mode: 'autonomous',
      status: 'done',
      project: 'first',
      ticketOrPr: 'example/app#42',
      slotId: null,
      branch: 'fixture-change',
      taskFile: null,
      createdByPrincipalId: owner,
      steps: [],
      decisions: [],
      metrics: {},
      createdAt: now,
      updatedAt: now,
      reviewResult: {
        recommendation: 'COMMENT',
        reviewMd: 'Fixture historical source review',
        lineComments: [],
        reviewSnapshot: { source: 'github-pr', headSha: head.repeat(40), capturedAt: now },
      },
    });
  }
}
if (scenario === 'automatic-qa') {
  const { captureQaAfterReview, resolvePRWorkflowDefaults } =
    await import('../packages/protocol/src/index.js');
  const file = path.join(fixture, 'projects/first/project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.qa.after_review = { enabled: true, profile_id: 'changes' };
  const sourcePath = path.join(fixture, 'runs/source-review.json');
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  source.qaAfterReview = captureQaAfterReview(
    project.qa,
    resolvePRWorkflowDefaults({ workflow: 'qa', farm: project.workflow_defaults }),
  );
  await json(sourcePath, source);
  project.qa.after_review.enabled = false;
  await json(file, project);
}
const readyGateDecision = {
  id: 'fixture-publication-gate',
  type: 'engine_human_gate',
  title: 'Publication gate',
  description: 'Request another independent review',
  actions: [
    { id: 'request-extra-review', label: 'Request Independent Review', style: 'secondary' },
  ],
  createdAt: new Date().toISOString(),
};
if (scenario === 'ready-gate-refusal') {
  const now = new Date().toISOString();
  await json(path.join(fixture, 'runs', 'gated-run.json'), {
    id: 'gated-run',
    familyId: 'gated-run',
    parentRunId: null,
    familyRootTicketOrPr: 'FIXTURE-GATE',
    lane: 'production',
    variant: null,
    flowType: 'fix-bug',
    mode: 'autonomous',
    status: 'blocked',
    project: 'first',
    ticketOrPr: 'FIXTURE-GATE',
    slotId: 'first-disabled',
    branch: 'fixture-gate',
    taskFile: null,
    createdByPrincipalId: 'legacy-env',
    steps: [],
    decisions: [readyGateDecision],
    metrics: {},
    createdAt: now,
    updatedAt: now,
  });
}
let gateway = launchGateway();
const terminateOwnedGateway = () => {
  if (gateway.exitCode !== null || !gateway.pid) return;
  try {
    process.kill(-gateway.pid, 'SIGTERM');
  } catch (error) {
    // The owned process group may have exited between its exit-code check and the signal.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};
process.once('exit', terminateOwnedGateway);
let connection: GatewayConnection | undefined;
async function connectGateway() {
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    timeout: 10000,
    credential: { token },
  });
  const deadline = Date.now() + 30_000;
  while (!connection && Date.now() < deadline) {
    if (gateway.exitCode !== null)
      throw new Error(`Isolated gateway exited with ${gateway.exitCode}`);
    try {
      connection = await client.connect();
    } catch (error) {
      if (!(error instanceof GatewayConnectionError)) throw error;
      // The owned process is still booting; retry only transport readiness, never an RPC refusal.
      await delay(200);
    }
  }
  assert(connection, 'Isolated gateway did not become ready');
}
async function stopGateway() {
  connection?.close();
  connection = undefined;
  if (gateway.exitCode !== null || !gateway.pid) return;
  const exited = once(gateway, 'exit');
  process.kill(-gateway.pid, 'SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
  if (!stopped) {
    process.kill(-gateway.pid, 'SIGKILL');
    await exited;
  }
}
try {
  await connectGateway();
  const base = {
    project: 'first',
    slotId: 'first-disabled',
    mode: 'autonomous',
    ticketOrPr: 'example/app#42',
  };
  if (
    [
      'publication-defaults',
      'publication-delivery',
      'publication-accounts',
      'publication-direct',
    ].includes(scenario)
  ) {
    const { team } = await connection!.call<{ team: PRTeamProfile }>('prRules.teamSave', {
      config: {
        name: 'Publication defaults fixture',
        account: { host: 'github.com', login: 'fixture-reviewer' },
        sources: [{ kind: 'repository', repo: 'example/app' }],
        predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
        repositories: [
          { repo: 'example/app', project: 'first', reviewProfile: 'fixture', excludedLabels: [] },
        ],
        execution: {
          workspacePolicy: { kind: 'exact', machine: 'first-node' },
          transport: 'native',
          models: [{ runner: 'codex', model: 'gpt-6-luna', effort: 'low' }],
        },
        githubTeams: [],
        notificationPrincipalIds: [],
      },
    });
    if (scenario === 'publication-direct') {
      const directRuns: any[] = [];
      const invoke = (flags: string[]) => {
        const child = spawnSync(
          'yarn',
          [
            '--cwd',
            path.join(root, 'apps/command-center'),
            'farmslot',
            '--url',
            `ws://127.0.0.1:${port}`,
            '--timeout',
            '30000',
            '--json',
            'run',
            'create',
            '--project',
            'first',
            '--flow-type',
            'review-pr',
            '--ticket',
            'example/app#42',
            '--review-machine',
            'first-node',
            '--runner',
            'codex',
            '--model',
            'gpt-6-luna',
            '--effort',
            'low',
            '--transport',
            'native',
            '--mode',
            'autonomous',
            ...flags,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              FARMSLOT_HOME: path.join(fixture, 'home'),
              FARMSLOT_GATEWAY_TOKEN: token,
            },
            encoding: 'utf8',
          },
        );
        assert(child.stdout, child.stderr);
        return { code: child.status, envelope: JSON.parse(child.stdout) };
      };
      for (const flags of [[], ['--no-publish-review']]) {
        const result = invoke(flags);
        assert.equal(result.code, 0, JSON.stringify(result.envelope));
        const run = result.envelope.data.run;
        assert.equal(run.status, 'created');
        assert.equal(run.slotId, null);
        assert(!run.agentContexts?.some((context: any) => context.nativeSession));
        assert.equal(run.reviewPublication.direct.policy.enabled, flags.length === 0);
        assert.equal(
          run.reviewPublication.direct.policy.source,
          flags.length === 0 ? 'farm' : 'request',
        );
        assert.equal(
          run.reviewPublication.direct.requested,
          flags.length === 0 ? undefined : false,
        );
        directRuns.push(run);
        await connection!.call('run.cancel', { runId: run.id });
      }
      const other = (
        await connection!.call<{ team: PRTeamProfile }>('prRules.teamSave', {
          config: {
            ...team.config,
            name: 'Other publisher',
            account: { host: 'github.com', login: 'other-publisher' },
          },
        })
      ).team;
      const ambiguous = invoke(['--publish-review']);
      assert.notEqual(ambiguous.code, 0);
      assert.match(JSON.stringify(ambiguous.envelope), /Several PR teams/);
      const selected = invoke(['--publish-review', '--team', other.id]);
      assert.equal(selected.code, 0, JSON.stringify(selected.envelope));
      const run = selected.envelope.data.run;
      assert.equal(run.reviewPublication.direct.policy.account.login, 'other-publisher');
      assert.equal(run.reviewPublication.direct.policy.source, 'request');
      directRuns.push(run);
      await assert.rejects(
        connection!.call('prReview.publish', { runId: run.id }),
        /must complete before publication/,
      );
      assert.equal(
        (await connection!.call<any>('run.get', { runId: run.id })).run.reviewPublication.error,
        undefined,
      );
      await assert.rejects(
        connection!.call('run.create', {
          ...base,
          flowType: 'review-pr',
          slotId: undefined,
          reviewWorkspaceTarget: { machine: 'first-node' },
          runner: 'codex',
          model: 'gpt-6-luna',
          transport: 'native',
          directReviewPublication: run.reviewPublication.direct,
        }),
        /cannot be supplied/,
      );
      await stopGateway();
      const runPath = path.join(fixture, 'runs', run.id + '.json');
      const completed = JSON.parse(await readFile(runPath, 'utf8'));
      completed.status = 'done';
      completed.reviewWorkspaceSubject = {
        repository: 'example/app',
        repositoryUrl: 'https://github.com/example/app.git',
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        branch: 'fixture-change',
        title: 'Direct fixture',
        body: '',
        capturedAt: new Date().toISOString(),
      };
      completed.reviewResult = {
        recommendation: 'COMMENT',
        reviewMd: 'Direct CLI retained review fixture.',
        lineComments: [],
        reviewSnapshot: {
          source: 'github-pr',
          headSha: 'a'.repeat(40),
          capturedAt: new Date().toISOString(),
        },
      };
      await json(runPath, completed);
      await json(path.join(fixture, 'publication-provider.json'), {
        posts: 0,
        reviews: [],
        head: 'a'.repeat(40),
        publisher: 'other-publisher',
      });
      gateway = launchGateway();
      await connectGateway();
      const published = await connection!.call<any>('prReview.publish', { runId: run.id });
      assert.equal(published.receipt.account.login, 'other-publisher');
      await connection!.call('run.archive', { runId: run.id });
      const replay = await connection!.call<any>('prReview.publish', { runId: run.id });
      assert.equal(replay.receipt.reviewId, published.receipt.reviewId);
      assert.equal(
        JSON.parse(await readFile(path.join(fixture, 'publication-provider.json'), 'utf8')).posts,
        1,
      );
      await json(
        path.resolve(process.argv[3] ?? path.join(root, 'temp/publication-direct'), 'receipt.json'),
        {
          passed: true,
          runs: directRuns,
          ambiguous: ambiguous.envelope,
          publication: published.receipt,
          workersLaunched: 0,
          completion: 'seeded historical result; actual CLI admission snapshot preserved',
          liveGithubWrites: 0,
        },
      );
    } else {
      const request = {
        teamId: team.id,
        pr: { host: 'github.com', repo: 'example/app', number: 42 },
        autoStart: false,
        review: { workflow: 'review', sessionIntent: 'resume', scope: 'incremental' },
        source: { client: 'fixture' },
      };
      const otherPublisher =
        scenario === 'publication-accounts'
          ? (
              await connection!.call<{ team: PRTeamProfile }>('prRules.teamSave', {
                config: {
                  ...team.config,
                  name: 'Other publisher',
                  account: { host: 'github.com', login: 'other-publisher' },
                },
              })
            ).team
          : undefined;
      const receipts: string[] = [];
      const selections = otherPublisher
        ? [
            { teamId: team.id, publishReview: undefined },
            { teamId: otherPublisher.id, publishReview: undefined },
          ]
        : (scenario === 'publication-delivery' ? [undefined] : [undefined, false]).map(
            (publishReview) => ({ teamId: team.id, publishReview }),
          );
      for (const { teamId: requestTeamId, publishReview } of selections) {
        const created = await connection!.call<PRReviewRequestResult>('prReview.submit', {
          request: {
            ...request,
            teamId: requestTeamId,
            idempotencyKey: `publication-${requestTeamId}-${String(publishReview)}`,
            review: {
              ...request.review,
              ...(publishReview === undefined ? {} : { publishReview }),
            },
          },
        });
        let resolved = created;
        for (let attempt = 0; attempt < 50 && !resolved.submission.intentId; attempt++) {
          await delay(100);
          resolved = await connection!.call<PRReviewRequestResult>('prReview.get', {
            id: created.submission.id,
          });
        }
        assert(resolved.intent, resolved.submission.error);
        const contribution = resolved.intent.contributions.find(
          (entry) => entry.submissionId === created.submission.id,
        )!;
        assert.deepEqual(contribution.configurationErrors, []);
        assert.equal(contribution.review?.publishReview, publishReview ?? true);
        assert.equal(
          contribution.policySources?.publication,
          publishReview === undefined ? 'farm' : 'request',
        );
        if (scenario === 'publication-defaults' && publishReview === false) {
          assert.equal(resolved.intent.status, 'needs-configuration');
          assert.match(
            resolved.intent.waitingReason ?? '',
            /incompatible review or publication choices/,
          );
        }
        if (otherPublisher && requestTeamId === otherPublisher.id) {
          assert.equal(resolved.intent.status, 'needs-configuration');
          assert.match(resolved.intent.waitingReason ?? '', /one owner and GitHub account/);
        }
        receipts.push(created.submission.id);
      }
      await stopGateway();
      if (scenario === 'publication-delivery') {
        const storePath = path.join(fixture, '.pr-rules.json');
        const history = JSON.parse(await readFile(storePath, 'utf8'));
        const intent = history.intents.find((entry: any) =>
          entry.contributions.some((source: any) => source.submissionId === receipts[0]),
        );
        const source = intent.contributions.find(
          (entry: any) => entry.submissionId === receipts[0],
        );
        intent.runId = 'publication-source';
        intent.status = 'completed';
        intent.reviewedSha = intent.headSha;
        await json(storePath, history);
        const now = new Date().toISOString();
        await json(path.join(fixture, 'runs/publication-source.json'), {
          id: 'publication-source',
          familyId: 'publication-family',
          parentRunId: null,
          familyRootTicketOrPr: 'example/app#42',
          lane: 'production',
          variant: null,
          flowType: 'review-pr',
          mode: 'autonomous',
          status: 'done',
          project: 'first',
          ticketOrPr: 'example/app#42',
          slotId: null,
          taskFile: null,
          steps: [],
          decisions: [],
          metrics: {},
          createdAt: now,
          updatedAt: now,
          createdByPrincipalId: source.ownerId,
          prWork: {
            kind: 'review',
            id: 'fixture-publication-work',
            sourceId: intent.id,
            pr: intent.pr,
            headSha: intent.headSha,
            review: {
              profile: intent.reviewProfile,
              ownerId: source.ownerId,
              options: source.review,
            },
            publication: {
              enabled: true,
              source: source.policySources.publication,
              teamId: team.id,
              account: team.config.account,
            },
          },
          reviewWorkspaceSubject: {
            repository: 'example/app',
            repositoryUrl: 'https://github.com/example/app.git',
            headSha: intent.headSha,
            baseSha: 'b'.repeat(40),
            branch: 'fixture-change',
            title: 'Fixture review',
            body: '',
            capturedAt: now,
          },
          reviewResult: {
            recommendation: 'COMMENT',
            reviewMd: 'Fixture retained static review.',
            lineComments: [
              { path: 'src/example.ts', line: 3, body: 'Fixture finding.', severity: 'suggestion' },
            ],
            reviewSnapshot: { source: 'github-pr', headSha: intent.headSha, capturedAt: now },
          },
        });
        await json(path.join(fixture, 'publication-provider.json'), {
          posts: 0,
          reviews: [],
          head: (publicationCase === 'stale' ? 'b' : 'a').repeat(40),
          loseResponse: publicationCase === 'lost-response',
          rejectPost: publicationCase === 'rejected',
          holdPost: ['concurrent', 'concurrent-tick'].includes(publicationCase),
        });
        if (publicationCase === 'concurrent-tick') {
          const file = path.join(fixture, 'runs/publication-source.json');
          const source = JSON.parse(await readFile(file, 'utf8'));
          source.reviewPublication = {
            checkedAt: new Date().toISOString(),
            error: 'Fixture awaits explicit retry',
          };
          await json(file, source);
        }
        if (publicationCase === 'revoked') {
          const file = path.join(fixture, 'projects/first/project.json');
          const project = JSON.parse(await readFile(file, 'utf8'));
          project.workflow_defaults['review-pr'].review.publishReview = false;
          await json(file, project);
        }
      }
      gateway = launchGateway();
      await connectGateway();
      if (scenario === 'publication-delivery') {
        if (['concurrent', 'concurrent-tick'].includes(publicationCase)) {
          let manualOutcome: any;
          const manual =
            publicationCase === 'concurrent-tick'
              ? connection!
                  .call('prReview.publish', { runId: 'publication-source' }, { timeoutMs: 45000 })
                  .then(
                    (value) => {
                      manualOutcome = { value };
                    },
                    (error) => {
                      manualOutcome = { error };
                    },
                  )
              : undefined;
          const file = path.join(fixture, 'publication-provider.json');
          let state;
          for (let attempt = 0; attempt < 100; attempt++) {
            state = JSON.parse(await readFile(file, 'utf8'));
            if (state.postingStarted) break;
            await delay(50);
          }
          assert(state?.postingStarted, 'Provider must be in its held POST');
          try {
            if (publicationCase === 'concurrent-tick') {
              const deadline = Date.now() + 33000;
              while (Date.now() < deadline) {
                const { run } = await connection!.call<any>('run.get', {
                  runId: 'publication-source',
                });
                assert.equal(
                  run.reviewPublication.error,
                  undefined,
                  'Scheduled publication must not overwrite a manual in-flight receipt',
                );
                assert.equal(run.reviewPublication.receipt.state, 'posting');
                await delay(250);
              }
            } else {
              await assert.rejects(
                connection!.call('prReview.publish', { runId: 'publication-source' }),
                /already in progress/,
              );
            }
            const { run } = await connection!.call<any>('run.get', { runId: 'publication-source' });
            assert.equal(
              run.reviewPublication.error,
              undefined,
              'Concurrent publication must not overwrite active receipt with an error',
            );
            assert.equal(run.reviewPublication.receipt.state, 'posting');
          } finally {
            await json(file, { ...JSON.parse(await readFile(file, 'utf8')), holdPost: false });
            if (manual) {
              await manual;
              if (manualOutcome.error) throw manualOutcome.error;
            }
          }
        }
        let terminal: any;
        for (let attempt = 0; attempt < 100; attempt++) {
          const { run } = await connection!.call<any>('run.get', { runId: 'publication-source' });
          if (
            run.reviewPublication?.error ||
            run.reviewPublication?.receipt?.state === 'published'
          ) {
            terminal = run;
            break;
          }
          await delay(100);
        }
        assert(terminal, 'Automatic publication did not retain an outcome');
        const providerFile = path.join(fixture, 'publication-provider.json');
        if (!['pass', 'concurrent', 'concurrent-tick'].includes(publicationCase)) {
          assert(
            terminal.reviewPublication.error,
            'Expected publication refusal or uncertain outcome',
          );
          assert.equal(
            JSON.parse(await readFile(providerFile, 'utf8')).posts,
            ['lost-response', 'rejected', 'concurrent', 'concurrent-tick'].includes(publicationCase)
              ? 1
              : 0,
          );
        }
        if (publicationCase === 'rejected') {
          assert.equal(
            terminal.reviewPublication.receipt.state,
            'prepared',
            'Definite provider rejection must retain a retryable receipt',
          );
          const state = JSON.parse(await readFile(providerFile, 'utf8'));
          assert.equal(state.reviews.length, 0);
          await json(providerFile, { ...state, rejectPost: false });
        }
        let sourceArchived = false;
        if (publicationCase === 'lost-response') {
          await connection!.call('run.archive', { runId: 'publication-source' });
          sourceArchived = true;
          await stopGateway();
          gateway = launchGateway();
          await connectGateway();
        }
        if (publicationCase === 'stale') {
          assert.match(terminal.reviewPublication.error, /changed since/);
          await assert.rejects(
            connection!.call('prReview.publish', { runId: 'publication-source' }),
            /changed since/,
          );
        } else {
          if (publicationCase === 'revoked') {
            assert.match(terminal.reviewPublication.error, /Current policy/);
            await stopGateway();
            const file = path.join(fixture, 'projects/first/project.json');
            const project = JSON.parse(await readFile(file, 'utf8'));
            project.workflow_defaults['review-pr'].review.publishReview = true;
            await json(file, project);
            gateway = launchGateway();
            await connectGateway();
          }
          const retried = await connection!.call<any>('prReview.publish', {
            runId: 'publication-source',
          });
          assert.equal(retried.receipt.reviewId, 77);
        }
        if (!sourceArchived) await connection!.call('run.archive', { runId: 'publication-source' });
        await stopGateway();
        gateway = launchGateway();
        await connectGateway();
        await delay(500);
        const provider = JSON.parse(await readFile(providerFile, 'utf8'));
        assert.equal(
          provider.posts,
          publicationCase === 'stale' ? 0 : publicationCase === 'rejected' ? 2 : 1,
        );
        const archived = JSON.parse(
          await readFile(path.join(fixture, 'runs/archive/publication-source.json'), 'utf8'),
        );
        if (publicationCase !== 'stale') {
          assert.equal(provider.payload.commit_id, 'a'.repeat(40));
          assert.equal(provider.payload.comments.length, 1);
          assert.equal(archived.reviewPublication.receipt.reviewId, 77);
          const retried = await connection!.call<any>('prReview.publish', {
            runId: 'publication-source',
          });
          assert.equal(retried.receipt.reviewId, 77);
          assert.equal(
            JSON.parse(await readFile(providerFile, 'utf8')).posts,
            publicationCase === 'rejected' ? 2 : 1,
          );
        }
        const activeRuns = await connection!.call<{ runs: Array<{ id: string }> }>('run.list');
        assert(
          !activeRuns.runs.some((run) => run.id === 'publication-source'),
          'Publication revived an archived run',
        );
        const evidence = path.resolve(
          process.argv[3] ?? path.join(root, 'temp/publication-delivery'),
        );
        await json(path.join(evidence, 'receipt.json'), {
          passed: true,
          case: publicationCase,
          posts: provider.posts,
          publication: archived.reviewPublication,
          source: 'seeded historical static review; no worker execution',
          provider: 'isolated gh fixture; no live GitHub writes',
        });
      }
      const stored = await connection!.call<PRRulesListResult>('prRules.list');
      const contributions = stored.intents.flatMap((intent) => intent.contributions);
      for (const [index, id] of receipts.entries()) {
        const contribution = contributions.find((entry) => entry.submissionId === id)!;
        assert.equal(contribution.review?.publishReview, !!otherPublisher || index === 0);
        assert.equal(
          contribution.policySources?.publication,
          otherPublisher || index === 0 ? 'farm' : 'request',
        );
      }
    }
  } else if (scenario === 'qa-pool') {
    const { slotId: _slot, ...request } = base;
    const unpinned = await connection!.call<DispatchQueueAddResult>('dispatch.queue.add', {
      ...request,
      flowType: 'qa',
    });
    assert.equal(unpinned.item.slotId, undefined, 'Pool QA must not pin a slot before launch');
    assert.deepEqual(unpinned.item.allowedSlots, ['first-disabled', 'first-other']);
    const pinned = await connection!.call<DispatchQueueAddResult>('dispatch.queue.add', {
      ...base,
      flowType: 'qa',
      ticketOrPr: 'example/app#43',
    });
    assert.equal(pinned.item.slotId, 'first-disabled');
    await stopGateway();
    gateway = launchGateway();
    await connectGateway();
    const listed = await connection!.call<DispatchQueueListResult>('dispatch.queue.list');
    const retained = listed.items.find((item) => item.id === unpinned.item.id)!;
    assert(retained);
    assert.equal(retained.slotId, undefined);
    assert.deepEqual(retained.allowedSlots, ['first-disabled', 'first-other']);
  } else if (scenario === 'profiles') {
    const first = await connection!.call<ConfigProjectResult>('config.project', {
      project: 'first',
    });
    const second = await connection!.call<ConfigProjectResult>('config.project', {
      project: 'second',
    });
    assert.equal(first.project.qa?.default_profile, 'changes');
    assert.equal(second.project.qa?.default_profile, 'candidate');
    assert.deepEqual(first.project.qa?.profiles[0].inputs, { scope: { kind: 'changes' } });
  } else if (scenario === 'legacy-queue') {
    const result = await connection!.call<DispatchQueueAddResult>('dispatch.queue.add', {
      ...base,
      flowType: 'review-pr',
      reviewValidationDepth: 'full-live',
      reviewTier: 'full',
    });
    assert.equal(result.item.flowType, 'qa');
    assert.equal(result.item.executionTemplateId, 'validation/shared');
    assert.equal(result.item.executionTemplate?.flow, 'validation');
    const canonical = await readFile(
      path.join(fixture, 'projects/first/shared/validation/shared.md'),
    );
    assert.equal(
      result.item.executionTemplate.sha256,
      createHash('sha256').update(canonical).digest('hex'),
    );
    assert.equal(result.item.slotId, 'first-disabled');
    assert.equal(result.item.reviewValidationDepth, undefined);
    assert.equal(result.item.reviewQaContract?.legacy?.validationDepth, 'full-live');
    const listed = await connection!.call<DispatchQueueListResult>('dispatch.queue.list');
    const persisted = listed.items.find((item) => item.id === result.item.id);
    assert(persisted, 'Normalized queue receipt must remain available');
    // Scheduler claim counters and waiting diagnostics can change between RPCs.
    // Compare every request field that establishes the migration contract.
    for (const field of [
      'id',
      'flowType',
      'project',
      'ticketOrPr',
      'slotId',
      'allowedSlots',
      'executionTemplateId',
      'executionTemplate',
      'reviewQaContract',
      'reviewValidationDepth',
      'completionPolicy',
      'qaProfileId',
      'qaInputs',
    ] as const)
      assert.deepEqual(persisted[field], result.item[field], field);
    assert.equal(persisted.runId, undefined, 'Disabled fixture slot must not launch work');
    await connection!.call('dispatch.queue.remove', { itemId: result.item.id });
  } else if (scenario === 'legacy-plan-repair') {
    const configurationError = (error: unknown) =>
      error instanceof GatewayRpcError && error.code === 'REVIEW_QA_NEEDS_CONFIGURATION';
    const staticPlan = [{ order: 1, runner: 'codex', validationDepth: 'static-code' }];
    const added = await connection!.call<DispatchQueueAddResult>('dispatch.queue.add', {
      ...base,
      flowType: 'dev',
      ticketOrPr: 'FIXTURE-PLAN',
      pendingReviewPlan: staticPlan,
    });
    // Seed a pre-ADR-058 queued plan while its owning gateway is stopped.
    await stopGateway();
    const queuePath = path.join(fixture, 'queue.json');
    const stored = JSON.parse(await readFile(queuePath, 'utf8'));
    const legacyPlan = [{ order: 1, runner: 'codex', validationDepth: 'full-live' }];
    stored.find((item: { id: string }) => item.id === added.item.id).pendingReviewPlan = legacyPlan;
    await json(queuePath, stored);
    gateway = launchGateway();
    await connectGateway();
    const queued = async () =>
      (await connection!.call<DispatchQueueListResult>('dispatch.queue.list')).items.find(
        (item) => item.id === added.item.id,
      );
    // Any intake runs a dispatch cycle over the whole queue, including the restored row.
    const kick = await connection!.call<DispatchQueueAddResult>('dispatch.queue.add', {
      ...base,
      flowType: 'dev',
      ticketOrPr: 'FIXTURE-KICK',
    });
    let held = await queued();
    for (let attempt = 0; attempt < 50 && !held?.waitingReason; attempt++) {
      await delay(100);
      held = await queued();
    }
    const hold = {
      id: held?.id,
      waitingReason: held?.waitingReason,
      plan: held?.pendingReviewPlan,
    };
    console.log(JSON.stringify({ hold }));
    assert.match(held?.waitingReason ?? '', /^Review\/QA migration: .*full-live/);
    assert.deepEqual(held?.pendingReviewPlan, legacyPlan, 'held plan stays visible and unchanged');
    await assert.rejects(
      connection!.call('dispatch.queue.update', {
        itemId: added.item.id,
        pendingReviewPlan: legacyPlan,
      }),
      configurationError,
    );
    assert.deepEqual((await queued())?.pendingReviewPlan, legacyPlan, 'refusal changes nothing');
    const { item: repaired } = await connection!.call<{ item: DispatchQueueAddResult['item'] }>(
      'dispatch.queue.update',
      { itemId: added.item.id, pendingReviewPlan: staticPlan },
    );
    await delay(500);
    const after = await queued();
    console.log(
      JSON.stringify({
        repair: {
          id: after?.id,
          waitingReason: after?.waitingReason,
          plan: after?.pendingReviewPlan,
        },
      }),
    );
    assert.equal(repaired.id, added.item.id, 'repair keeps the receipt identity');
    assert.equal(after?.id, added.item.id);
    assert.deepEqual(after?.pendingReviewPlan, staticPlan);
    assert.doesNotMatch(after?.waitingReason ?? '', /^Review\/QA migration: /);
    for (const itemId of [added.item.id, kick.item.id])
      await connection!.call('dispatch.queue.remove', { itemId });
  } else if (scenario === 'ready-gate-refusal') {
    await assert.rejects(
      connection!.call('run.resolveDecision', {
        runId: 'gated-run',
        decisionId: readyGateDecision.id,
        actionId: 'request-extra-review',
        selectionData: {
          reviewRequest: { loops: [{ runner: 'codex', validationDepth: 'full-live' }] },
        },
      }),
      (error: unknown) => {
        assert(error instanceof GatewayRpcError);
        assert.equal(error.code, 'REVIEW_QA_NEEDS_CONFIGURATION', error.message);
        assert.match(error.message, /^reviewRequest\.loops\[0\]/);
        return true;
      },
    );
    const { run } = await connection!.call<{ run: any }>('run.get', { runId: 'gated-run' });
    const gate = run.decisions.find(
      (decision: { id: string }) => decision.id === readyGateDecision.id,
    );
    console.log(
      JSON.stringify({
        gate: { id: gate?.id, resolvedAt: gate?.resolvedAt ?? null, status: run.status },
      }),
    );
    assert.equal(gate?.resolvedAt, undefined, 'the human gate stays pending');
    assert.equal(gate?.selectionData, undefined);
    assert.equal(run.status, 'blocked');
    assert.equal(run.slotId, 'first-disabled', 'no restore or slot change');
  } else if (scenario === 'bare-pr') {
    const result = await connection!.call<DispatchQueueAddResult>('dispatch.queue.add', {
      ...base,
      ticketOrPr: '42',
      flowType: 'review-pr',
      reviewValidationDepth: 'full-live',
    });
    assert.equal(
      result.item.ticketOrPr,
      'example/app#42',
      'Bare PR request must retain canonical PR identity',
    );
    assert.equal(result.item.flowType, 'qa');
    const listed = await connection!.call<DispatchQueueListResult>('dispatch.queue.list');
    assert.equal(
      listed.items.find((item) => item.id === result.item.id)?.ticketOrPr,
      'example/app#42',
    );
  } else if (scenario === 'linked-qa' || scenario === 'automatic-qa') {
    const { team } = await connection!.call<{ team: PRTeamProfile }>('prRules.teamSave', {
      config: {
        name: 'Linked QA fixture',
        account: { host: 'github.com', login: 'fixture-reviewer' },
        sources: [{ kind: 'repository', repo: 'example/app' }],
        predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
        repositories: [
          { repo: 'example/app', project: 'first', reviewProfile: 'fixture', excludedLabels: [] },
        ],
        execution: {
          slotPolicy: { kind: 'exact', slotId: 'first-disabled' },
          models: [{ runner: 'scripted', model: 'scripted' }],
        },
        githubTeams: [],
        notificationPrincipalIds: [],
      },
    });
    if (scenario === 'automatic-qa') {
      const projectPath = path.join(fixture, 'projects/first/project.json');
      const restart = async (edit?: (project: any) => void) => {
        await stopGateway();
        if (edit) {
          const project = JSON.parse(await readFile(projectPath, 'utf8'));
          edit(project);
          await json(projectPath, project);
        }
        gateway = launchGateway();
        await connectGateway();
      };
      let sourceArchived = false;
      const waitSource = async (predicate: (run: any) => boolean) => {
        for (let attempt = 0; attempt < 80; attempt++) {
          const run = sourceArchived
            ? JSON.parse(
                await readFile(path.join(fixture, 'runs/archive/source-review.json'), 'utf8'),
              )
            : (await connection!.call<any>('run.get', { runId: 'source-review' })).run;
          if (predicate(run)) return run;
          await delay(100);
        }
        throw new Error('Automatic QA source did not reach expected state');
      };
      await waitSource((run) => run.qaAfterReview.state === 'blocked');
      assert.equal(
        (await connection!.call<PRRulesListResult>('prRules.list')).submissions?.length ?? 0,
        0,
      );
      await connection!.call('run.archive', { runId: 'source-review' });
      sourceArchived = true;
      assert((await waitSource((run) => Boolean(run.archivedAt))).archivedAt);
      await restart((project) => {
        project.qa.after_review.enabled = true;
      });
      const source = await waitSource((run) => Boolean(run.qaAfterReview.submissionId));
      const first = await connection!.call<PRRulesListResult>('prRules.list');
      assert.equal(first.submissions?.length, 1);
      assert.equal(first.submissions![0].request.sourceReviewRunId, 'source-review');
      assert.equal(first.submissions![0].request.autoStart, true);
      const id = first.submissions![0].id;
      assert.equal(source.qaAfterReview.submissionId, id);
      await restart();
      await waitSource((run) => run.qaAfterReview.submissionId === id);
      assert.deepEqual(
        (await connection!.call<PRRulesListResult>('prRules.list')).submissions?.map(
          (item) => item.id,
        ),
        [id],
      );
      await restart((project) => {
        project.qa.after_review.enabled = false;
      });
      const disabled = await waitSource((run) => run.qaAfterReview.state === 'blocked');
      assert.match(disabled.qaAfterReview.error, /disabled|opt.in|enabled/i);
      assert.equal(
        (await connection!.call<PRRulesListResult>('prRules.list')).submissions?.length,
        1,
      );
      const old = await connection!.call<any>('run.get', { runId: 'stale-review' });
      assert.equal(old.run.qaAfterReview, undefined);
      assert.equal(
        (await connection!.call<{ runs: Array<{ flowType: string }> }>('run.list')).runs.filter(
          (run) => run.flowType === 'qa',
        ).length,
        0,
      );
    } else {
      const request = {
        teamId: team.id,
        pr: { host: 'github.com', repo: 'example/app', number: 42 },
        autoStart: false,
        sourceReviewRunId: 'source-review',
        review: { workflow: 'qa', sessionIntent: 'reset', scope: 'full', qaProfileId: 'changes' },
        source: { client: 'fixture' },
      };
      const submitted = await connection!.call<PRReviewRequestResult>('prReview.submit', {
        request: { ...request, idempotencyKey: 'linked-one' },
      });
      let receipt = submitted;
      for (let attempt = 0; attempt < 40 && !receipt.submission.intentId; attempt++) {
        await delay(100);
        receipt = await connection!.call<PRReviewRequestResult>('prReview.get', {
          id: submitted.submission.id,
        });
        if (receipt.submission.error) throw new Error(receipt.submission.error);
      }
      assert(receipt.submission.intentId);
      assert(receipt.intent);
      assert.deepEqual(receipt.submission.sourceReview, {
        runId: 'source-review',
        headSha: 'a'.repeat(40),
      });
      assert.deepEqual(
        receipt.intent.contributions[0].sourceReview,
        receipt.submission.sourceReview,
      );
      const retry = await connection!.call<PRReviewRequestResult>('prReview.submit', {
        request: { ...request, idempotencyKey: 'linked-one' },
      });
      assert.equal(retry.submission.id, receipt.submission.id);
      await assert.rejects(
        connection!.call('prReview.submit', {
          request: { ...request, sourceReviewRunId: 'foreign-review', idempotencyKey: 'foreign' },
        }),
        (error: unknown) => error instanceof GatewayRpcError && error.code === 'AUTH_FORBIDDEN',
      );
      const stale = await connection!.call<PRReviewRequestResult>('prReview.submit', {
        request: { ...request, sourceReviewRunId: 'stale-review', idempotencyKey: 'stale' },
      });
      let rejected = stale;
      for (let attempt = 0; attempt < 40 && !rejected.submission.error; attempt++) {
        await delay(100);
        rejected = await connection!.call<PRReviewRequestResult>('prReview.get', {
          id: stale.submission.id,
        });
      }
      assert.match(rejected.submission.error ?? '', /head changed/);
      assert.equal(rejected.submission.intentId, undefined);
      assert.equal(
        (await connection!.call<DispatchQueueListResult>('dispatch.queue.list')).items.length,
        0,
      );
    }
  } else if (['legacy-completed', 'legacy-pending', 'approved-qa'].includes(scenario)) {
    const { team } = await connection!.call<{ team: PRTeamProfile }>('prRules.teamSave', {
      config: {
        name: 'Fixture QA',
        account: { host: 'github.com', login: 'fixture-reviewer' },
        sources: [{ kind: 'repository', repo: 'example/app' }],
        predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
        repositories: [
          { repo: 'example/app', project: 'first', reviewProfile: 'fixture', excludedLabels: [] },
        ],
        execution: {
          slotPolicy: { kind: 'exact', slotId: 'first-disabled' },
          models: [{ runner: 'codex', model: 'gpt-6-luna', effort: 'low' }],
        },
        review: {
          sessionIntent: 'resume',
          scope: 'incremental',
          ...(scenario === 'approved-qa'
            ? { workflow: 'qa', qaProfileId: 'changes' }
            : { validationDepth: 'full-live' }),
        },
        githubTeams: [],
        notificationPrincipalIds: [],
      },
    });
    const saved = await connection!.call<{ rule: PRTriggerRule }>('prRules.ruleSave', {
      config: {
        name: 'Fixture QA intake',
        teamId: team.id,
        predicate: team.config.predicate,
        actions: [{ kind: 'review', autoStart: false }],
        pollIntervalMs: 300000,
        maxAdmissionsPerScan: 10,
        rereviewOnHeadChange: false,
      },
    });
    const { rule } = await connection!.call<{ rule: PRTriggerRule }>('prRules.setEnabled', {
      id: saved.rule.id,
      revision: saved.rule.revision,
      enabled: true,
      backfill: true,
    });
    const initial = await connection!.call<PRRulesListResult>('prRules.list', {});
    assert.equal(initial.intents.length, 1);
    assert.deepEqual(initial.intents[0].contributions[0].configurationErrors, []);
    if (scenario === 'approved-qa') {
      assert.deepEqual(
        initial.intents[0].contributions[0].review?.qaInputs,
        {
          scope: { kind: 'changes' },
          domain: 'fixture-default',
        },
        'PR intake must freeze farm QA inputs before admission',
      );
      assert.equal(initial.intents[0].contributions[0].reviewObservation?.decision, 'APPROVED');
      const accepted = await connection!.call<{ intent: PRReviewIntent }>('prRules.accept', {
        id: initial.intents[0].id,
      });
      assert(
        accepted.intent.contributions[0].acceptedAt,
        'Explicit QA must be accepted despite GitHub approval',
      );
      assert(!accepted.intent.waitingReason?.includes('not needed'));
      const current = await connection!.call<PRRulesListResult>('prRules.list', {});
      assert(
        current.intents.find((item) => item.id === accepted.intent.id)?.contributions[0].acceptedAt,
      );
    } else {
      // Seed an actual pre-migration durable record while its owning gateway is stopped.
      await stopGateway();
      const storePath = path.join(fixture, '.pr-rules.json');
      const stored = JSON.parse(await readFile(storePath, 'utf8'));
      const legacy = stored.intents[0];
      legacy.id = createHash('sha256')
        .update(JSON.stringify(['github.com/example/app#42', legacy.headSha, legacy.reviewProfile]))
        .digest('hex');
      delete legacy.contributions[0].reviewPurpose;
      legacy.contributions[0].review = {
        sessionIntent: 'resume',
        scope: 'incremental',
        validationDepth: 'full-live',
      };
      if (scenario === 'legacy-completed') {
        legacy.status = 'completed';
        legacy.runId = 'historical-run';
        legacy.reviewedSha = 'a'.repeat(40);
      }
      await json(storePath, stored);
      const historical = structuredClone(legacy);
      gateway = launchGateway();
      await connectGateway();
      const observed = await connection!.call<{ preview: PRRulePreview }>('prRules.scan', {
        id: rule.id,
      });
      assert.equal(observed.preview.complete, true);
      assert.deepEqual(observed.preview.sourceErrors, []);
      assert.equal(observed.preview.items[0].review?.qaProfileId, 'changes');
      const rescanned = await connection!.call<PRRulesListResult>('prRules.list', {});
      assert.equal(
        rescanned.intents.length,
        1,
        'Preset resolution must not create another legacy QA intent',
      );
      assert.equal(rescanned.intents[0].id, historical.id);
      if (scenario === 'legacy-completed') {
        assert.deepEqual(
          rescanned.intents[0],
          historical,
          'Completed legacy verdict must remain unchanged',
        );
        assert.equal(
          (await connection!.call<DispatchQueueListResult>('dispatch.queue.list')).items.length,
          0,
        );
      } else {
        assert.equal(
          rescanned.intents[0].contributions[0].eligible,
          true,
          'Legacy pending intent must retain eligibility',
        );
        assert.equal(rescanned.intents[0].status, 'held');
      }
    }
  } else {
    const configurationError = (pattern: RegExp) => (error: unknown) => {
      assert(error instanceof GatewayRpcError);
      assert.equal(error.code, 'REVIEW_QA_NEEDS_CONFIGURATION', error.message);
      assert.match(error.message, pattern);
      return true;
    };
    await assert.rejects(
      connection!.call('dispatch.queue.add', {
        ...base,
        flowType: 'review-pr',
        reviewTier: 'full',
      }),
      configurationError(/ambiguous/),
    );
    await assert.rejects(
      connection!.call('dispatch.queue.add', { ...base, flowType: 'qa', qaProfileId: 'candidate' }),
      configurationError(/does not exist in this farm/),
    );
    await assert.rejects(
      connection!.call('dispatch.queue.add', {
        ...base,
        flowType: 'review-pr',
        qaProfileId: 'changes',
      }),
      configurationError(/Static Review cannot/),
    );
    assert.equal(
      (await connection!.call<DispatchQueueListResult>('dispatch.queue.list')).items.length,
      0,
    );
  }
  console.log(
    JSON.stringify({
      passed: true,
      scenario,
      endpoint: 'isolated production gateway',
      workerExecution: false,
      provider: ['publication-delivery', 'publication-direct'].includes(scenario)
        ? 'isolated publication gh fixture; no live GitHub writes'
        : 'read-only deterministic gh process fixture',
    }),
  );
} catch (error) {
  if (scenario === 'publication-delivery') {
    const provider = await readFile(path.join(fixture, 'publication-provider.json'), 'utf8').catch(
      (readError) => {
        if (readError.code === 'ENOENT') return null;
        throw readError;
      },
    );
    await json(
      path.join(
        path.resolve(process.argv[3] ?? path.join(root, 'temp/publication-delivery')),
        'failure.json',
      ),
      { error: String(error), provider: provider ? JSON.parse(provider) : null, fixture },
    );
  }
  const details = (await readFile(log, 'utf8'))
    .replaceAll(token, '[redacted]')
    .split('\n')
    .slice(-40)
    .join('\n');
  throw new Error(`${String(error)}\n${details}`, { cause: error });
} finally {
  await stopGateway();
  await rm(fixture, { recursive: true, force: true });
  process.removeListener('exit', terminateOwnedGateway);
}
