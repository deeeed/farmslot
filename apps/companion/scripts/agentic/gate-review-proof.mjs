#!/usr/bin/env node
// Native proof for the Companion gate review: a private fixture gateway holds two runs parked at a
// publish gate under a one-review policy. On the first, one criterion is proven with a screenshot
// and a text check, one has no verdict, and both reviewers passed. On the second, every criterion
// is proven and codex passed, but the latest claude review has open findings: the gateway still
// counts the policy satisfied and offers approve-publish. Each gate's actions come from the
// gateway's own policy functions. The recipe drives the Companion UI; these phases only own the
// fixture gateway and read its persisted state.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const proofDir = path.join(root, 'temp/companion-gate-review-proof');
const statePath = path.join(proofDir, 'state.json');
const project = 'companion-proof';
const slotId = 'companion-proof-slot';
const runId = 'gate-review-fixture-run';
const decisionId = 'gate-review-fixture-gate';
const issuesRunId = 'gate-review-fixture-issues-run';
const issuesDecisionId = 'gate-review-fixture-issues-gate';
const phase = process.argv[2];

const CRITERIA = [
  'The fixture screen renders its recipe list',
  'The fixture publish note is reviewed by a human',
];
const REVIEW_DEPTH = {
  minimumIndependentReviews: 1,
  requireCrossRunner: false,
  extraLoopsRequested: 0,
  requestedBy: 'dispatch',
};

/** The actions the gateway's publish gate offers for these reviews under REVIEW_DEPTH. */
function gatewayGateActions(independentReviews) {
  const script = `
    import { publicationGateDecisionActions } from './services/gateway/src/run-engine/gate-policy.ts';
    import { independentReviewPolicySatisfied } from './services/gateway/src/quality/review-policy.ts';
    const { policy, reviews } = JSON.parse(process.argv[1]);
    const reviewSatisfied = independentReviewPolicySatisfied(policy, reviews);
    process.stdout.write(JSON.stringify(publicationGateDecisionActions({ reviewSatisfied, independentReviews: reviews })));
  `;
  return JSON.parse(
    execFileSync(
      path.join(root, 'node_modules/.bin/tsx'),
      ['-e', script, JSON.stringify({ policy: REVIEW_DEPTH, reviews: independentReviews })],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
}

const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};
const evidence = (name, value) =>
  writeJson(
    path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR ?? proofDir, `${name}.json`),
    value,
  );

function rpc(method, params = {}) {
  const state = readState();
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FARMSLOT_GATEWAY: `ws://127.0.0.1:${state.port}`,
          FARMSLOT_GATEWAY_TOKEN: state.token,
        },
      },
    ),
  );
}
const gate = (id = runId, gateId = decisionId) =>
  rpc('run.get', { runId: id }).run.decisions.find((d) => d.id === gateId);
const openUrl = (route) => {
  assert(process.env.IOS_SIMULATOR, 'Set IOS_SIMULATOR to the leased simulator');
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    process.env.IOS_SIMULATOR,
    `farmslot-development://${route}`,
  ]);
};

function stopFixture() {
  if (!fs.existsSync(statePath)) return;
  const { pid } = readState();
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    // The owned process group already exited.
    if (error.code !== 'ESRCH') throw error;
  }
}

/** A task dir whose ledger records `proven` for the first `provenCount` criteria only. */
function seedTask(fixture, name, provenCount) {
  const taskDir = path.join(fixture, 'projects', project, 'tasks/dev', name);
  const recordedAt = new Date().toISOString();
  fs.mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'TASK.md'), `# ${name}\n`);
  writeJson(path.join(taskDir, 'inputs/handoff.json'), {
    schemaVersion: 1,
    task: { title: name, acceptanceCriteria: CRITERIA },
  });
  fs.copyFileSync(
    path.join(root, 'apps/companion/store-assets/raw/ios-phone/02_recipes.png'),
    path.join(taskDir, 'artifacts/after-gate-fixture.png'),
  );
  fs.writeFileSync(
    path.join(taskDir, 'artifacts/gate-fixture-check.txt'),
    'fixture check: recipe list rendered with 4 rows\n',
  );
  writeJson(path.join(taskDir, 'artifacts/acceptance-status.json'), {
    schemaVersion: 1,
    criteria: CRITERIA.slice(0, provenCount).map((text, index) => ({
      id: `AC-${index + 1}`,
      text,
      verdict: 'proven',
      proofMode: 'visual',
      evidence: ['artifacts/after-gate-fixture.png', 'artifacts/gate-fixture-check.txt'],
      recipeNodes: ['capture-recipes'],
      updatedAt: recordedAt,
    })),
  });
  return path.join(taskDir, 'TASK.md');
}

function seedRun(fixture, { id, gateId, taskFile, title, claude }) {
  const now = new Date().toISOString();
  // Ids follow the gateway's independent-review source: `independent-review-<loop>`.
  const review = (runner, model, loopNumber, overrides = {}) => ({
    id: `independent-review-${loopNumber}`,
    source: 'dispatch',
    runner,
    model,
    crossRunner: true,
    loopNumber,
    verdict: 'pass',
    unresolvedCount: 0,
    startedAt: now,
    completedAt: now,
    ...overrides,
  });
  const independentReviews = [review('codex', 'gpt-5.5', 1), review('claude', 'opus', 2, claude)];
  const actions = gatewayGateActions(independentReviews);
  const diffStat = { files: 7, additions: 312, deletions: 41 };
  writeJson(path.join(fixture, 'runs', `${id}.json`), {
    id,
    familyId: id,
    parentRunId: null,
    familyRootTicketOrPr: 'FIXTURE-GATE-REVIEW',
    lane: 'production',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    status: 'human-gating',
    project,
    ticketOrPr: 'FIXTURE-GATE-REVIEW',
    slotId,
    branch: 'feat/fixture-gate-review',
    taskFile,
    createdByPrincipalId: 'legacy-env',
    steps: [],
    metrics: {},
    engineState: { publishGate: { independentReviews } },
    decisions: [
      {
        id: gateId,
        type: 'engine_human_gate',
        title: 'Publication gate',
        description: [
          '**Package:** fixture-package',
          '**Target:** ready',
          '**Branch:** feat/fixture-gate-review',
          `**Files:** ${diffStat.files} (+${diffStat.additions} -${diffStat.deletions})`,
        ].join('\n'),
        actions,
        createdAt: now,
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          branch: 'feat/fixture-gate-review',
          diffStat,
          workerReport: 'Fixture worker report.',
          publicationTarget: 'ready',
          independentReviews,
          prPackage: {
            id: 'fixture-package',
            packageHash: 'fixture-package-hash',
            artifactPath: 'artifacts/publication-package.json',
            branch: 'feat/fixture-gate-review',
            diffStat,
            draftTitle: title,
            draftBody: 'Fixture package body.',
            reviewArtifactIds: [],
            reviewDepth: REVIEW_DEPTH,
            gatePolicy: {
              owner: 'human',
              publishAuthority: 'human',
              reason: 'fixture publish gate',
            },
            publicationTarget: 'ready',
            publicationStatus: 'not_published',
            createdAt: now,
          },
        },
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
}

if (phase === 'setup') {
  // A failed earlier attempt leaves its gateway and fixture behind; replace both.
  stopFixture();
  fs.rmSync(proofDir, { recursive: true, force: true });
  const fixture = path.join(proofDir, 'farm');
  const port = Number(process.env.COMPANION_PROOF_GATEWAY_PORT ?? 18795);
  const token = randomBytes(32).toString('hex');
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
  for (const name of ['scripts', 'services', 'packages'])
    fs.symlinkSync(path.join(root, name), path.join(fixture, name));
  fs.writeFileSync(path.join(fixture, 'CLAUDE.md'), '# Companion gate review proof fixture\n');
  writeJson(path.join(fixture, 'projects', project, 'project.json'), {
    name: project,
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  });
  fs.mkdirSync(path.join(fixture, 'pool'));
  seedRun(fixture, {
    id: runId,
    gateId: decisionId,
    taskFile: seedTask(fixture, 'gate-review-fixture', 1),
    title: 'feat(companion): fixture gate review package',
    claude: {},
  });
  seedRun(fixture, {
    id: issuesRunId,
    gateId: issuesDecisionId,
    taskFile: seedTask(fixture, 'gate-review-fixture-issues', 2),
    title: 'feat(companion): fixture review findings package',
    claude: { verdict: 'issues', unresolvedCount: 2 },
  });
  const log = fs.openSync(path.join(proofDir, 'gateway.log'), 'a', 0o600);
  const gateway = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      FARMSLOT_ROOT: fixture,
      FARMSLOT_HOME: path.join(fixture, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
      FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
      FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
      FARMSLOT_BACKLOG_FILE: path.join(fixture, '.backlog.json'),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_TOKEN: token,
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    },
  });
  gateway.unref();
  writeJson(statePath, { fixture, port, token, pid: gateway.pid });
  const deadline = Date.now() + 60000;
  let seeded;
  while (!seeded && Date.now() < deadline) {
    try {
      seeded = gate();
    } catch (error) {
      // The owned gateway is still booting; any other failure repeats until the deadline.
      if (Date.now() + 250 >= deadline) throw error;
      await sleep(250);
    }
  }
  assert.equal(seeded?.type, 'engine_human_gate');
  assert.equal(seeded.resolvedAt, undefined);
  const progress = rpc('task.progress', { slotId, runId });
  assert.deepEqual(
    progress.acceptanceCriteria?.map((criterion) => criterion.id),
    ['AC-1', 'AC-2'],
    'the gateway reads both registered criteria from the fixture task',
  );
  assert.deepEqual(
    progress.acceptanceStatus?.criteria.map((criterion) => [criterion.id, criterion.verdict]),
    [['AC-1', 'proven']],
    'only AC-1 has a verdict',
  );
  const issues = gate(issuesRunId, issuesDecisionId);
  for (const seededGate of [seeded, issues]) {
    assert.ok(
      seededGate?.actions.some((action) => action.id === 'approve-publish'),
      'one passing review satisfies the policy, so the gateway offers approve-publish',
    );
  }
  evidence('gate-before', { gate: seeded, acceptance: progress.acceptanceStatus, issues });
  console.log(JSON.stringify({ gateway: `ws://127.0.0.1:${port}`, runId, issuesRunId }));
} else if (phase === 'gateway-url') {
  // Printed bare so the recipe can type them as `{{outputs.<node>.stdout}}`.
  process.stdout.write(`ws://127.0.0.1:${readState().port}`);
} else if (phase === 'token') {
  process.stdout.write(readState().token);
} else if (phase === 'relaunch') {
  // Start from a fresh app process so a screen left open by an earlier attempt cannot take input.
  assert(process.env.IOS_SIMULATOR, 'Set IOS_SIMULATOR to the leased simulator');
  const bundleId = process.env.BUNDLE_ID ?? 'net.siteed.farmslot.development';
  execFileSync('xcrun', [
    'simctl',
    'launch',
    '--terminate-running-process',
    process.env.IOS_SIMULATOR,
    bundleId,
  ]);
} else if (phase === 'open-connection') {
  openUrl('/connection');
} else if (phase === 'open-run') {
  openUrl(`/workspace/run/${runId}/evidence`);
} else if (phase === 'open-issues-gate') {
  openUrl(`/gate-review/${issuesDecisionId}?runId=${issuesRunId}`);
} else if (phase === 'verify-pending' || phase === 'verify-issues-pending') {
  // Pressing a withheld publish approval must not reach the gateway.
  const pending = phase === 'verify-pending' ? gate() : gate(issuesRunId, issuesDecisionId);
  evidence(`gate-after-approval-press-${phase}`, pending);
  assert.equal(pending.resolvedAt, undefined, 'the gate is still open after the approval press');
} else if (phase === 'verify-hold') {
  let resolved;
  for (let attempt = 0; attempt < 40; attempt++) {
    resolved = gate();
    if (resolved?.resolvedAt) break;
    await sleep(250);
  }
  evidence('gate-after-hold', resolved ?? null);
  assert.equal(resolved?.resolvedAction, 'hold', 'the gate resolved with the hold action');
} else if (phase === 'cleanup') {
  stopFixture();
  fs.rmSync(proofDir, { recursive: true, force: true });
} else {
  throw new Error(`Unknown phase ${phase}`);
}
