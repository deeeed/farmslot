#!/usr/bin/env node
// Native proof for the Companion gate review: a private fixture gateway holds three runs parked at
// a publish gate under a one-review policy. On the first, one criterion is proven with a screenshot
// and a text check, one has no verdict, both reviewers passed, and a worker packet asks to approve
// the gate. On the second, every criterion is proven and codex passed, but the latest claude review
// has open findings: the gateway still counts the policy satisfied and offers approve-publish. On
// the third, every criterion is proven and no review passed, so the gateway offers only the review
// bypass. Each gate's actions come from the gateway's own policy functions, and each run has its
// own registered fixture slot. The recipe drives the Companion UI; these phases own the fixture
// gateway (loopback-only, unauthenticated), start the app on it, and read its persisted state.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { groupAlive } from './proof-gateway.mjs';
import { seedIOSGatewayProfile } from './seed-ios-gateway-profile.mjs';
import { openSimulatorDevClient } from './simulator-dev-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const proofDir = path.join(root, 'temp/companion-gate-review-proof');
const statePath = path.join(proofDir, 'proof-state.json');
const gatewayLogPath = path.join(proofDir, 'gateway.log');
const proofSecretPath = path.join(proofDir, 'service-secret');
const project = 'companion-proof';
// One registered slot per fixture run: a slot's task is its active run's.
const SLOTS = {
  'gate-review-fixture-run': 'companion-proof-slot-1',
  'gate-review-fixture-issues-run': 'companion-proof-slot-2',
  'gate-review-fixture-bypass-run': 'companion-proof-slot-3',
  'gate-review-fixture-request-run': 'companion-proof-slot-4',
};
const runId = 'gate-review-fixture-run';
const decisionId = 'gate-review-fixture-gate';
const issuesRunId = 'gate-review-fixture-issues-run';
const issuesDecisionId = 'gate-review-fixture-issues-gate';
const bypassRunId = 'gate-review-fixture-bypass-run';
const bypassDecisionId = 'gate-review-fixture-bypass-gate';
const requestRunId = 'gate-review-fixture-request-run';
const requestDecisionId = 'gate-review-fixture-request-gate';
const PACKET_PATH = 'artifacts/gate-approve.packet.json';
const FIXTURE_PROFILE_ID = 'gate-review-fixture';
const SWAPPED_PACKAGE = { id: 'fixture-package-refreshed', packageHash: 'fixture-package-hash-2' };
const phase = process.argv[2];
// The recipe runner passes the slot's device as SIMULATOR and the app as FARMSLOT_RECIPE_APP_ID.
const simulator = process.env.IOS_SIMULATOR || process.env.SIMULATOR;
const bundleId =
  process.env.BUNDLE_ID || process.env.FARMSLOT_RECIPE_APP_ID || 'net.siteed.farmslot.development';

const CRITERIA = [
  'The fixture screen renders its recipe list',
  'The fixture publish note is reviewed by a human',
];
const REVIEW_POLICY = {
  minimumReviews: 1,
  requestedBy: 'dispatch',
};

/** The actions the gateway's publish gate offers for these reviews under REVIEW_POLICY. */
function gatewayGateActions(reviews) {
  const script = `
    import { publicationGateDecisionActions } from './services/gateway/src/run-engine/gate-policy.ts';
    import { reviewPolicySatisfied } from './packages/protocol/src/runs/review-policy.ts';
    const { policy, reviews } = JSON.parse(process.argv[1]);
    const reviewSatisfied = reviewPolicySatisfied(policy, reviews);
    const preparedPackage = { headSha: '1'.repeat(40), reviewPolicy: policy };
    process.stdout.write(JSON.stringify(publicationGateDecisionActions({ reviewSatisfied, reviews, preparedPackage })));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        JSON.stringify({ policy: REVIEW_POLICY, reviews: reviews }),
      ],
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
          ...(fs.existsSync(proofSecretPath)
            ? {
                FARMSLOT_HOME: path.join(state.fixture, 'home'),
                FARMSLOT_GATEWAY_PROFILE: 'proof',
              }
            : {}),
        },
      },
    ),
  );
}
const gate = (id = runId, gateId = decisionId) =>
  rpc('run.get', { runId: id }).run.decisions.find((d) => d.id === gateId);
const openUrl = (route) => {
  assert(simulator, 'Set IOS_SIMULATOR or SIMULATOR to the leased simulator');
  execFileSync('xcrun', ['simctl', 'openurl', simulator, `farmslot-development://${route}`]);
};

function seedFixtureGateway(port) {
  seedIOSGatewayProfile({
    simulator,
    bundleId,
    profile: {
      id: fs.existsSync(proofSecretPath)
        ? `${FIXTURE_PROFILE_ID}-${readState().pid}`
        : FIXTURE_PROFILE_ID,
      name: 'Gate review fixture',
      url: `ws://127.0.0.1:${port}`,
      kind: 'lan',
      ...(fs.existsSync(proofSecretPath)
        ? { authMode: 'token', presetSecret: fs.readFileSync(proofSecretPath, 'utf8').trim() }
        : { authMode: 'none' }),
    },
  });
}

async function stopFixture(keepTerminals = false) {
  if (!fs.existsSync(statePath)) return;
  const { pid, terminalSession, workspaceTerminalSession } = readState();
  for (const session of keepTerminals
    ? []
    : [terminalSession, workspaceTerminalSession].filter(Boolean)) {
    const stopped = spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' });
    if (stopped.status !== 0 && !/can't find session|no server running/i.test(stopped.stderr))
      throw new Error(`Owned terminal fixture did not stop: ${stopped.stderr}`);
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    // The owned process group already exited.
    if (error.code !== 'ESRCH') throw error;
    return;
  }
  await waitFor('the owned gateway process group stops', () => !groupAlive(pid), 5000);
}

/** Polls `read` until it returns a value; failures repeat until the deadline, then throw. */
async function waitFor(what, read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = read();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting until ${what}`);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(250);
  }
}

/** Starts the fixture gateway in its own process group and records it in the proof state. */
function startGateway(fixture, port) {
  const log = fs.openSync(gatewayLogPath, 'a', 0o600);
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
      // Loopback-only and unauthenticated, so the app's seeded profile needs no credential.
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_TOKEN: '',
      FARMSLOT_GATEWAY_PASSWORD: '',
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'test-automation',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    },
  });
  gateway.unref();
  const owned = fs.existsSync(statePath) ? readState() : {};
  writeJson(statePath, {
    fixture,
    port,
    pid: gateway.pid,
    ...(owned.terminalSession ? { terminalSession: owned.terminalSession } : {}),
    ...(owned.workspaceTerminalSession
      ? { workspaceTerminalSession: owned.workspaceTerminalSession }
      : {}),
  });
}

/** How many times the Companion has authenticated to the fixture gateway, from the gateway's log. */
const companionAuthCount = () =>
  fs.readFileSync(gatewayLogPath, 'utf8').split('[auth] companion authenticated').length - 1;

/** Whether the app process holds an open socket to the fixture gateway. */
function appConnected() {
  const app = execFileSync('xcrun', ['simctl', 'get_app_container', simulator, bundleId, 'app'], {
    encoding: 'utf8',
  }).trim();
  const pids = spawnSync('pgrep', ['-f', `${app}/`], { encoding: 'utf8' }).stdout.trim();
  assert.ok(pids, 'the Companion process is running');
  const { port } = readState();
  // lsof exits 1 when the process has no matching socket.
  const sockets = spawnSync('lsof', [
    '-a',
    '-nP',
    `-p${pids.split('\n').join(',')}`,
    `-iTCP:${port}`,
    '-sTCP:ESTABLISHED',
  ]);
  return sockets.status === 0;
}

/** A task dir whose ledger records `proven` for the first `provenCount` criteria only. */
function seedTask(fixture, name, provenCount) {
  const taskDir = path.join(fixture, '.task/dev', name);
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
  // 278,576 bytes, more than the viewer's 200,000-byte text preview reads.
  fs.writeFileSync(
    path.join(taskDir, 'artifacts/gate-fixture-check.txt'),
    'fixture check: recipe list rendered with 4 rows\n' + 'fixture log line\n'.repeat(16_384),
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

function seedRun(fixture, { id, gateId, taskFile, title, codex = {}, claude, artifactManifest }) {
  const now = new Date().toISOString();
  // Each fixture result has a separate reviewer session and captured head.
  const review = (runner, model, loopNumber, overrides = {}) => ({
    id: `review-${loopNumber}`,
    source: 'dispatch',
    runner,
    model,
    effort: 'high',
    mode: 'cold',
    reviewerSessionId: `${id}-reviewer-${loopNumber}`,
    reviewedHeadSha: '1111111111111111111111111111111111111111',
    loopNumber,
    verdict: 'pass',
    unresolvedCount: 0,
    startedAt: now,
    completedAt: now,
    ...overrides,
  });
  const reviews = [review('codex', 'gpt-5.5', 1, codex), review('claude', 'opus', 2, claude)];
  const actions = gatewayGateActions(reviews);
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
    slotId: SLOTS[id],
    branch: 'feat/fixture-gate-review',
    taskFile: path.relative(fixture, taskFile),
    createdByPrincipalId: 'test-automation',
    steps: [],
    metrics: {},
    engineState: { publishGate: { reviews } },
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
          ...(artifactManifest ? { artifactManifest } : {}),
          publicationTarget: 'ready',
          reviews,
          prPackage: {
            id: 'fixture-package',
            packageHash: 'fixture-package-hash',
            artifactPath: 'artifacts/publication-package.json',
            branch: 'feat/fixture-gate-review',
            diffStat,
            draftTitle: title,
            draftBody: 'Fixture package body.',
            reviewArtifactIds: [],
            reviewPolicy: REVIEW_POLICY,
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

if (phase === 'prepare-worktree-terminal') {
  const owned = readState();
  await stopFixture(true);
  const workspaceId = `terminal-proof-${randomUUID().slice(0, 8)}`;
  const workspaceTerminalSession = `review-${workspaceId}`;
  writeJson(statePath, { ...owned, workspaceTerminalSession });
  try {
    execFileSync('tmux', [
      'new-session',
      '-d',
      '-s',
      workspaceTerminalSession,
      "printf 'TERMINAL PROOF WORKTREE\\n'; exec sleep 1800",
    ]);
    execFileSync('tmux', [
      'set-option',
      '-t',
      workspaceTerminalSession,
      '@farmslot-review-workspace',
      workspaceId,
    ]);
    const file = path.join(owned.fixture, 'runs', `${bypassRunId}.json`);
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    const taskPath = path.dirname(path.resolve(owned.fixture, run.taskFile));
    const runtime = path.join(taskPath, 'inputs/runtime/node_modules/@farmslot');
    fs.mkdirSync(runtime, { recursive: true });
    fs.symlinkSync(path.join(root, 'packages/agent-runtime'), path.join(runtime, 'agent-runtime'));
    run.status = 'monitoring';
    run.transport = 'tmux';
    run.flowType = 'review-pr';
    run.autoRecoveryDisabled = true;
    run.slotId = null;
    run.decisions = [];
    run.reviewWorkspace = {
      workspaceId,
      machine: `${project}-node`,
      executionNodeId: 'local',
      checkoutPath: owned.fixture,
      taskPath,
      artifactPath: path.join(taskPath, 'artifacts'),
    };
    run.agentContexts = [
      {
        id: 'review',
        role: 'review',
        label: 'Worktree reviewer',
        status: 'working',
        runId: run.id,
        slotId: null,
        runner: 'scripted',
        promptDeliveryStartedAt: new Date().toISOString(),
        target: { session: workspaceTerminalSession, target: workspaceTerminalSession },
      },
    ];
    writeJson(file, run);
    startGateway(owned.fixture, owned.port);
    await waitFor(
      'the worktree fixture serves its run',
      () => rpc('run.get', { runId: run.id }).run,
      30000,
    );
    const snapshot = rpc('terminal.snapshot', { slotId: '', runId: run.id, lines: 20 });
    assert(snapshot.lines.some((line) => line.includes('TERMINAL PROOF WORKTREE')));
    evidence('worktree-terminal-target', {
      runId: run.id,
      session: workspaceTerminalSession,
      node: `${project}-node`,
    });
  } catch (error) {
    await stopFixture();
    throw error;
  }
} else if (phase === 'setup-terminal') {
  // Reuse the isolated gateway/profile setup. This phase creates no model session or review.
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'setup-actions'], {
    cwd: root,
    stdio: 'pipe',
  });
  const owned = readState();
  await stopFixture();
  const terminalSession = `companion-terminal-proof-${randomUUID().slice(0, 8)}`;
  // Require the existing server; never start or stop a tmux server for proof.
  execFileSync('tmux', ['list-sessions'], { stdio: 'pipe' });
  try {
    execFileSync('tmux', [
      'new-session',
      '-d',
      '-s',
      terminalSession,
      '-n',
      'dev',
      "printf 'TERMINAL PROOF WORKER\\n'; exec sleep 1800",
    ]);
    writeJson(statePath, { ...owned, terminalSession });
    execFileSync('tmux', [
      'new-window',
      '-d',
      '-t',
      terminalSession,
      '-n',
      'rev-proof-3',
      "printf 'TERMINAL PROOF REVIEWER\\n'; exec sleep 1800",
    ]);
    const poolFile = path.join(owned.fixture, 'pool', `${project}.json`);
    const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
    pool.schema_version = 2;
    pool.slots.find((slot) => slot.id === SLOTS[requestRunId]).session = terminalSession;
    writeJson(poolFile, pool);
    const file = path.join(owned.fixture, 'runs', `${requestRunId}.json`);
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    run.status = 'monitoring';
    run.readOnly = false;
    run.transport = 'tmux';
    run.decisions = [];
    run.steps = [{ name: 'review', status: 'running' }];
    run.agentContexts = ['dev', 'rev-proof-3'].map((window) => ({
      id: window,
      role: window === 'dev' ? 'dev' : 'review',
      label: window,
      status: 'working',
      runId: run.id,
      slotId: run.slotId,
      runner: 'scripted',
      target: { session: terminalSession, window, target: `${terminalSession}:${window}.0` },
    }));
    writeJson(file, run);
    const finishedFile = path.join(owned.fixture, 'runs', `${issuesRunId}.json`);
    const finished = JSON.parse(fs.readFileSync(finishedFile, 'utf8'));
    finished.status = 'done';
    finished.decisions = [];
    writeJson(finishedFile, finished);
    startGateway(owned.fixture, owned.port);
    await waitFor(
      'the terminal fixture serves its active run',
      () => rpc('run.get', { runId: run.id }).run,
      30000,
    );
    evidence('terminal-target', {
      runId: run.id,
      slotId: run.slotId,
      contextId: 'rev-proof-3',
      role: 'review',
      session: terminalSession,
      window: 'rev-proof-3',
      node: pool.machine,
      finishedRunId: issuesRunId,
    });
    console.log(JSON.stringify({ runId: run.id, finishedRunId: issuesRunId, slotId: run.slotId }));
  } catch (error) {
    await stopFixture();
    throw error;
  }
} else if (phase === 'setup' || phase === 'setup-actions') {
  // A failed earlier attempt leaves its gateway and fixture behind; replace both.
  await stopFixture();
  fs.rmSync(proofDir, { recursive: true, force: true });
  const fixture = path.join(proofDir, 'farm');
  const port = Number(process.env.COMPANION_PROOF_GATEWAY_PORT ?? 18795);
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
  for (const name of ['scripts', 'services', 'packages'])
    fs.symlinkSync(path.join(root, name), path.join(fixture, name));
  fs.writeFileSync(path.join(fixture, 'CLAUDE.md'), '# Companion gate review proof fixture\n');
  writeJson(path.join(fixture, 'projects', project, 'project.json'), {
    name: project,
    default_branch: 'main',
    // The slot repo is the fixture root, so a slot's task dir is the run's recorded one.
    paths: { runtime_dir: '.agent', artifact_dir: `projects/${project}/tasks` },
  });
  // The run's slot is registered so posture and slot reads resolve it; disabled,
  // so nothing is dispatched to it.
  writeJson(path.join(fixture, 'pool', `${project}.json`), {
    machine: `${project}-node`,
    host: 'localhost',
    project,
    platform: 'cli',
    os: process.platform,
    slots: Object.values(SLOTS).map((id) => ({
      id,
      enabled: false,
      repo: fixture,
      session: id,
      resources: {},
    })),
  });
  const taskFile = seedTask(fixture, 'gate-review-fixture', 1);
  // A worker packet asking the operator to approve this gate from run detail.
  writeJson(path.join(path.dirname(taskFile), PACKET_PATH), {
    schema: 'farmslot.interactive.operator-packet.v1',
    id: 'fixture-approve-packet',
    runId,
    title: 'Fixture publish request',
    intent: 'decision',
    body: { format: 'markdown', text: 'The worker asks to publish the fixture package.' },
    actions: [
      {
        id: 'approve',
        label: 'Approve publish from packet',
        kind: 'decision.resolve',
        safety: 'operator-confirmed',
        payload: { decisionId, actionId: 'approve-publish' },
      },
    ],
    createdAt: new Date().toISOString(),
  });
  seedRun(fixture, {
    id: runId,
    gateId: decisionId,
    taskFile,
    title: 'feat(companion): fixture gate review package',
    claude: {},
    artifactManifest: [{ path: PACKET_PATH, purpose: 'interactive-packet' }],
  });
  seedRun(fixture, {
    id: issuesRunId,
    gateId: issuesDecisionId,
    taskFile: seedTask(fixture, 'gate-review-fixture-issues', 2),
    title: 'feat(companion): fixture review findings package',
    claude: { verdict: 'issues', unresolvedCount: 2 },
  });
  seedRun(fixture, {
    id: bypassRunId,
    gateId: bypassDecisionId,
    taskFile: seedTask(fixture, 'gate-review-fixture-bypass', 2),
    title: 'feat(companion): fixture review bypass package',
    codex: { verdict: 'issues', unresolvedCount: 1 },
    claude: { verdict: 'issues', unresolvedCount: 2 },
  });
  seedRun(fixture, {
    id: requestRunId,
    gateId: requestDecisionId,
    taskFile: seedTask(fixture, 'gate-review-fixture-request', 2),
    title: 'feat(companion): fixture shared review request',
    claude: {},
  });
  if (phase === 'setup-actions') {
    // Setup-time fixture only. Never submit a review or publish from this proof.
    const file = path.join(fixture, 'runs', `${requestRunId}.json`);
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    const decision = run.decisions[0];
    const payload = decision.payload;
    // A terminal reference keeps this display fixture immutable during live inspection.
    // It cannot dispatch, refresh a source checkout or publish.
    run.status = 'failed';
    run.readOnly = true;
    const reviewId = `pipeline-review-${requestRunId}`;
    const finding = {
      reviewId,
      file: 'evidence-manifest.json',
      line: 33,
      description: 'AC-1 needs a resulting position. The submitted order rests.',
    };
    const review = {
      ...payload.reviews[0],
      id: reviewId,
      model: 'gpt-6.1-sol',
      verdict: 'issues',
      unresolvedCount: 1,
      issues: [finding],
      session: {
        reviewId,
        runner: 'codex',
        model: 'gpt-6.1-sol',
        sessionId: 'fixture-retained-session',
        continuity: 'fresh',
        lastReviewedHeadSha: '1111111111111111111111111111111111111111',
      },
    };
    payload.reviews = [review];
    run.engineState.publishGate.reviews = [review];
    run.autoRecoveryDisabled = true;
    decision.actions = gatewayGateActions([review]);
    payload.reviewLineageOptions = [
      {
        context: { familyId: requestRunId, reviewId },
        runner: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'high',
        reviewedAt: review.completedAt,
      },
    ];
    payload.reviewRoundBudget = {
      used: 2,
      limit: 5,
      remaining: 3,
      label: 'Review rounds 2/5',
      noVerdict: 0,
      noVerdictLimit: 3,
    };
    payload.gateReadiness = {
      state: 'not-ready',
      identity: { runId: requestRunId, generation: 1 },
      reasons: [
        {
          code: 'review-fix-required',
          prerequisite: 'review',
          message: 'Review found 1 issue. Fix and pass review before publishing.',
          allowedReviewOverrides: ['approve-publish-unresolved'],
        },
        {
          code: 'review-result-required',
          prerequisite: 'review',
          message:
            'Required current-head reviews need valid structured result artifacts for this package.',
        },
      ],
      findings: [finding],
      findingsDigest: 'fixture-findings',
    };
    writeJson(file, run);
  }
  if (phase === 'setup-actions') {
    // Modern clients require an explicit service login, rather than a solo-mode person.
    const home = path.join(fixture, 'home');
    execFileSync(
      process.execPath,
      [
        path.join(root, 'packages/cli/bin/farmslot.mjs'),
        'credential',
        'issue',
        '--principal',
        'gate-actions-proof',
        '--subject',
        'service',
        '--role',
        'admin',
        '--scope',
        'global',
        '--offline',
        '--secret-file',
        proofSecretPath,
      ],
      { cwd: root, env: { ...process.env, FARMSLOT_HOME: home }, stdio: 'pipe' },
    );
    writeJson(path.join(home, 'gateways.json'), {
      active: 'proof',
      gateways: {
        proof: {
          url: `ws://127.0.0.1:${port}`,
          authMode: 'token',
          secret: fs.readFileSync(proofSecretPath, 'utf8').trim(),
        },
      },
    });
  }
  startGateway(fixture, port);
  const seeded = await waitFor('the fixture gateway serves the gate', () => gate(), 60000);
  if (phase === 'setup-actions') {
    const ready = gate(requestRunId, requestDecisionId);
    assert.equal(ready.resolvedAt, undefined);
    assert.equal(ready.payload.reviewLineageOptions[0].runner, 'codex');
    evidence('gate-actions-before', ready);
    console.log(JSON.stringify({ gateway: `ws://127.0.0.1:${port}`, runId: requestRunId }));
    process.exit(0);
  }
  assert.equal(seeded?.type, 'engine_human_gate');
  assert.equal(seeded.resolvedAt, undefined);
  const progress = rpc('task.progress', { slotId: SLOTS[runId], runId });
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
  const bypass = gate(bypassRunId, bypassDecisionId);
  assert.ok(
    bypass?.actions.some((action) => action.id === 'approve-publish-unresolved') &&
      !bypass.actions.some((action) => action.id === 'approve-publish'),
    'with no passing review the gateway offers only the review bypass',
  );
  evidence('gate-before', { gate: seeded, acceptance: progress.acceptanceStatus, issues });
  console.log(JSON.stringify({ gateway: `ws://127.0.0.1:${port}`, runId, issuesRunId }));
} else if (phase === 'verify-warm-refusal') {
  const { fixture, port } = readState();
  await stopFixture();
  const file = path.join(fixture, 'runs', `${requestRunId}.json`);
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Setup before starting the isolated gateway. The missing retained session must refuse
  // the request before any reviewer can start; orchestration also remains disabled.
  run.readOnly = false;
  run.status = 'human-gating';
  writeJson(file, run);
  startGateway(fixture, port);
  await waitFor('the fixture gateway starts', () => rpc('fleet.status'), 30000);
  let refusal;
  try {
    rpc('run.resolveDecision', {
      runId: requestRunId,
      decisionId: requestDecisionId,
      actionId: 'request-review',
      selectionData: {
        reviewRequest: {
          runner: 'codex',
          model: 'gpt-6.1-sol',
          effort: 'high',
          mode: 'warm',
          context: {
            reviewLineages: [
              { familyId: requestRunId, reviewId: `pipeline-review-${requestRunId}` },
            ],
          },
        },
      },
    });
  } catch (error) {
    refusal = String(error.stderr);
  }
  assert.match(refusal ?? '', /WARM review refused.*no verified retained session/);
  const after = rpc('run.get', { runId: requestRunId }).run;
  assert.equal(
    after.decisions.find((entry) => entry.id === requestDecisionId).resolvedAt,
    undefined,
  );
  assert.deepEqual(after.reviewRoundAdmissions, run.reviewRoundAdmissions);
  assert.equal((after.agentContexts ?? []).filter((entry) => entry.role === 'review').length, 0);
  evidence('warm-refusal', {
    refusal,
    unresolved: true,
    newReviewers: 0,
    admissionsUnchanged: true,
  });
} else if (phase === 'relaunch') {
  // Start from a fresh app process so a screen left open by an earlier attempt cannot take input.
  assert(simulator, 'Set IOS_SIMULATOR or SIMULATOR to the leased simulator');
  seedFixtureGateway(readState().port);
  await openSimulatorDevClient(simulator);
} else if (phase === 'open-run') {
  openUrl(`/workspace/run/${runId}/evidence`);
} else if (phase === 'open-issues-gate') {
  openUrl(`/gate-review/${issuesDecisionId}?runId=${issuesRunId}`);
} else if (phase === 'open-bypass-gate') {
  openUrl(`/gate-review/${bypassDecisionId}?runId=${bypassRunId}`);
} else if (phase === 'open-request-gate') {
  openUrl(`/gate-review/${requestDecisionId}?runId=${requestRunId}`);
} else if (phase === 'verify-review-request') {
  const resolved = await waitFor(
    'the shared review request resolves',
    () => {
      const current = gate(requestRunId, requestDecisionId);
      return current?.resolvedAt ? current : null;
    },
    10000,
  );
  assert.equal(resolved.resolvedAction, 'request-review');
  assert.deepEqual(resolved.selectionData.reviewRequest, {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    mode: 'cold',
  });
  evidence('gate-shared-review-request', resolved);
} else if (
  phase === 'verify-pending' ||
  phase === 'verify-issues-pending' ||
  phase === 'verify-bypass-pending' ||
  phase === 'verify-bypass-swap-pending'
) {
  // A withheld approval, or a confirmation the operator cancelled, must not reach the gateway.
  const pending =
    phase === 'verify-pending'
      ? gate()
      : phase === 'verify-issues-pending'
        ? gate(issuesRunId, issuesDecisionId)
        : gate(bypassRunId, bypassDecisionId);
  evidence(`gate-after-approval-press-${phase}`, pending);
  assert.equal(pending.resolvedAt, undefined, 'the gate is still open after the approval press');
  if (phase === 'verify-bypass-swap-pending') {
    assert.equal(
      pending.payload.prPackage.packageHash,
      SWAPPED_PACKAGE.packageHash,
      'the open gate carries the replacement package',
    );
  }
} else if (phase === 'swap-bypass-package') {
  // Replace the third gate's package while its confirmation is open, as a package refresh does.
  // The gateway keeps runs in memory, so it is restarted on the edited run file.
  const { fixture, port, pid } = readState();
  const before = gate(bypassRunId, bypassDecisionId).payload.prPackage;
  const authsBefore = companionAuthCount();
  await stopFixture();
  await waitFor('the fixture gateway exits', () => !groupAlive(pid), 15000);
  const runFile = path.join(fixture, 'runs', `${bypassRunId}.json`);
  const stored = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const stale = stored.decisions.find((decision) => decision.id === bypassDecisionId);
  Object.assign(stale.payload.prPackage, SWAPPED_PACKAGE);
  writeJson(runFile, stored);
  startGateway(fixture, port);
  const after = await waitFor(
    'the restarted gateway serves the replacement package',
    () => gate(bypassRunId, bypassDecisionId)?.payload.prPackage,
    60000,
  );
  assert.equal(after.packageHash, SWAPPED_PACKAGE.packageHash);
  assert.notEqual(after.packageHash, before.packageHash);
  // The open confirmation must see the replacement before Send, so wait for the app's reconnect.
  await waitFor(
    'the Companion signs in to the restarted gateway',
    () => companionAuthCount() > authsBefore,
    90000,
  );
  // Its re-read of the run follows sign-in on loopback.
  await sleep(750);
  evidence('gate-package-swap', { before, after });
} else if (phase === 'background-app') {
  // Another app in front backgrounds the Companion, which closes its gateway socket.
  assert(simulator, 'Set IOS_SIMULATOR or SIMULATOR to the leased simulator');
  execFileSync('xcrun', ['simctl', 'launch', simulator, 'com.apple.Preferences']);
  await waitFor('the Companion closes its gateway socket', () => !appConnected(), 15000);
} else if (phase === 'unjudge-bypass-criterion') {
  // While the app is away, the third run's ledger loses AC-2's verdict. No run field changes.
  const { fixture } = readState();
  const ledgerFile = path.join(
    fixture,
    'projects',
    project,
    'tasks/dev/gate-review-fixture-bypass/artifacts/acceptance-status.json',
  );
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  ledger.criteria = ledger.criteria.filter((criterion) => criterion.id !== 'AC-2');
  writeJson(ledgerFile, ledger);
  const progress = rpc('task.progress', { slotId: SLOTS[bypassRunId], runId: bypassRunId });
  assert.deepEqual(
    progress.acceptanceStatus?.criteria.map((criterion) => [criterion.id, criterion.verdict]),
    [['AC-1', 'proven']],
    'the gateway reads the ledger without AC-2',
  );
  evidence('bypass-ledger-unjudged', progress.acceptanceStatus);
} else if (phase === 'hold-bypass-gate') {
  // While the app is away, the third gate is held through the gateway, bound to its package.
  const open = gate(bypassRunId, bypassDecisionId);
  const prPackage = open.payload.prPackage;
  rpc('run.resolveDecision', {
    runId: bypassRunId,
    decisionId: bypassDecisionId,
    actionId: 'hold',
    selectionData: {
      publicationTarget: open.payload.publicationTarget,
      selectedEvidenceKeys: prPackage.selectedEvidenceKeys ?? [],
      packageId: prPackage.id,
      packageHash: prPackage.packageHash,
      packageHeadSha: prPackage.headSha,
    },
  });
  const held = await waitFor(
    'the third gate resolves with hold',
    () => {
      const current = gate(bypassRunId, bypassDecisionId);
      return current?.resolvedAt ? current : null;
    },
    10000,
  );
  assert.equal(held.resolvedAction, 'hold');
  evidence('bypass-gate-held-while-away', held);
} else if (phase === 'foreground-app') {
  // Launching the running app brings it back without a restart; it signs in again on a new socket.
  assert(simulator, 'Set IOS_SIMULATOR or SIMULATOR to the leased simulator');
  const authsBefore = companionAuthCount();
  execFileSync('xcrun', ['simctl', 'launch', simulator, bundleId]);
  await waitFor(
    'the Companion signs in to the fixture gateway again',
    () => companionAuthCount() > authsBefore,
    30000,
  );
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
  await stopFixture();
  fs.rmSync(proofDir, { recursive: true, force: true });
} else {
  throw new Error(`Unknown phase ${phase}`);
}
