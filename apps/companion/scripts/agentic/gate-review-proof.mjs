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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const proofDir = path.join(root, 'temp/companion-gate-review-proof');
const statePath = path.join(proofDir, 'state.json');
const gatewayLogPath = path.join(proofDir, 'gateway.log');
const project = 'companion-proof';
// One registered slot per fixture run: a slot's task is its active run's.
const SLOTS = {
  'gate-review-fixture-run': 'companion-proof-slot-1',
  'gate-review-fixture-issues-run': 'companion-proof-slot-2',
  'gate-review-fixture-bypass-run': 'companion-proof-slot-3',
};
const runId = 'gate-review-fixture-run';
const decisionId = 'gate-review-fixture-gate';
const issuesRunId = 'gate-review-fixture-issues-run';
const issuesDecisionId = 'gate-review-fixture-issues-gate';
const bypassRunId = 'gate-review-fixture-bypass-run';
const bypassDecisionId = 'gate-review-fixture-bypass-gate';
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
const REVIEW_DEPTH = {
  minimumReviews: 1,
  requireCrossRunner: false,
  extraLoopsRequested: 0,
  requestedBy: 'dispatch',
};

/** The actions the gateway's publish gate offers for these reviews under REVIEW_DEPTH. */
function gatewayGateActions(reviews) {
  const script = `
    import { publicationGateDecisionActions } from './services/gateway/src/run-engine/gate-policy.ts';
    import { reviewPolicySatisfied } from './services/gateway/src/quality/review-policy.ts';
    const { policy, reviews } = JSON.parse(process.argv[1]);
    const reviewSatisfied = reviewPolicySatisfied(policy, reviews);
    process.stdout.write(JSON.stringify(publicationGateDecisionActions({ reviewSatisfied, reviews: reviews })));
  `;
  return JSON.parse(
    execFileSync(
      path.join(root, 'node_modules/.bin/tsx'),
      ['-e', script, JSON.stringify({ policy: REVIEW_DEPTH, reviews: reviews })],
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
        env: { ...process.env, FARMSLOT_GATEWAY: `ws://127.0.0.1:${state.port}` },
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

/**
 * Start the app on the fixture gateway: one saved profile for the loopback
 * fixture, active, replacing the gateways earlier runs saved. Setup-time only:
 * the app is stopped, nothing on screen is set, and the connection flow is not
 * what this recipe proves. Uses the React Native AsyncStorage iOS layout: small
 * values inline in manifest.json, large ones in a file named by the key's MD5.
 */
function seedFixtureGateway(port) {
  const terminated = spawnSync('xcrun', ['simctl', 'terminate', simulator, bundleId], {
    encoding: 'utf8',
  });
  // simctl reports "found nothing to terminate" when the app is not running, which is the goal.
  if (terminated.status !== 0 && !/found nothing to terminate/i.test(terminated.stderr)) {
    throw new Error(`simctl terminate failed: ${terminated.stderr.trim()}`);
  }
  const data = execFileSync('xcrun', ['simctl', 'get_app_container', simulator, bundleId, 'data'], {
    encoding: 'utf8',
  }).trim();
  const storage = path.join(
    data,
    'Library/Application Support',
    bundleId,
    'RCTAsyncLocalStorage_V1',
  );
  const manifestPath = path.join(storage, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {};
  const url = `ws://127.0.0.1:${port}`;
  const profile = {
    id: FIXTURE_PROFILE_ID,
    name: 'Gate review fixture',
    url,
    kind: 'lan',
    authMode: 'none',
  };
  const values = {
    '@farmslot:gatewayProfiles': JSON.stringify([profile]),
    '@farmslot:activeGatewayProfileId': FIXTURE_PROFILE_ID,
    '@farmslot:gatewayUrl': url,
  };
  for (const [key, value] of Object.entries(values)) {
    // A value an earlier run stored out of line would shadow nothing once the
    // manifest holds it inline, but it would be left behind; remove it.
    fs.rmSync(path.join(storage, createHash('md5').update(key).digest('hex')), { force: true });
    manifest[key] = value;
  }
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}

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

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
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
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    },
  });
  gateway.unref();
  writeJson(statePath, { fixture, port, pid: gateway.pid });
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
    taskFile,
    createdByPrincipalId: 'legacy-env',
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
            reviewPolicy: REVIEW_DEPTH,
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
  startGateway(fixture, port);
  const seeded = await waitFor('the fixture gateway serves the gate', () => gate(), 60000);
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
} else if (phase === 'relaunch') {
  // Start from a fresh app process so a screen left open by an earlier attempt cannot take input.
  assert(simulator, 'Set IOS_SIMULATOR or SIMULATOR to the leased simulator');
  seedFixtureGateway(readState().port);
  execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', simulator, bundleId]);
} else if (phase === 'open-run') {
  openUrl(`/workspace/run/${runId}/evidence`);
} else if (phase === 'open-issues-gate') {
  openUrl(`/gate-review/${issuesDecisionId}?runId=${issuesRunId}`);
} else if (phase === 'open-bypass-gate') {
  openUrl(`/gate-review/${bypassDecisionId}?runId=${bypassRunId}`);
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
  stopFixture();
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
  stopFixture();
  fs.rmSync(proofDir, { recursive: true, force: true });
} else {
  throw new Error(`Unknown phase ${phase}`);
}
