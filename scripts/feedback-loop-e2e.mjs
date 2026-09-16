#!/usr/bin/env node
// feedback-loop-e2e.mjs — proves the retrospective feedback loop through a real,
// isolated production gateway endpoint (no mocks, no model calls, no live farm).
//
// Boots `services/gateway/src/index.ts` on a free localhost port with an isolated
// FARMSLOT_HOME / FARMSLOT_RUNS_DIR, seeds deterministic fixture runs derived from
// the saved review evidence, then drives the gateway RPC surface the operator and
// the bulk closeout script use:
//
//   1. family.observability.get  -> retrospective payload carries deduplicated
//      feedback candidates (human/bot kinds, reviewed commit, attribution).
//   2. run.resolveDecision landed -> the learnings-draft gate writes the ledger;
//      a card without a canonical destination is refused and stays pending.
//   3. family.observability.get  -> the same candidate now shows `consumedBy`.
//   4. scripts/bulk-resolve-retros.py --from-plan -> dry-run then real closeout:
//      the audited decision resolves, a drifted hash and a run without a
//      recorded destination are refused, and the JSON receipt records both.
//
// Usage: node scripts/feedback-loop-e2e.mjs            (exit 0 = every assertion held)
//        node scripts/feedback-loop-e2e.mjs --serve    (seed, start gateway + Vite UI, stay up
//                                                       for CDP validation; ports in <scratch>/ports.json)
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP = path.join(REPO, 'apps', 'command-center', 'scripts', 'cdp.mjs');
const PROJECT = 'e2e-feedback-farm';
const PROJECT_DIR = path.join(REPO, 'projects', PROJECT);
const LIBRARY_REPO = 'git@github.com:example/perps-recipe-library.git';
const PR = 'MetaMask/metamask-mobile#34865';
const COMMENT_URL = 'https://github.com/MetaMask/metamask-mobile/pull/34865#discussion_r3916065775';
const SOURCE_KEY = 'github.com/metamask/metamask-mobile#34865:review-comment:3916065775';

const scratch = mkdtempSync(path.join(tmpdir(), 'feedback-loop-e2e-'));
const home = path.join(scratch, 'home');
const runsDir = path.join(scratch, 'runs');
const tasksDir = path.join(scratch, 'tasks');
const digestDir = path.join(scratch, 'digest');
for (const dir of [home, runsDir, tasksDir, digestDir]) mkdirSync(dir, { recursive: true });

const failures = [];
function check(condition, label, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(
      `  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`,
    );
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// The closeout script hashes `json.dumps(decision, sort_keys=True)`; ask python for the
// exact bytes instead of re-implementing its separators here.
async function pyDecisionHash(decision) {
  const result = await exec(
    'python3',
    [
      '-c',
      'import sys,json,hashlib;print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True).encode()).hexdigest())',
    ],
    {},
    { stdin: JSON.stringify(decision) },
  );
  return result.stdout.trim();
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function seedProject() {
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(
    path.join(PROJECT_DIR, 'project.json'),
    `${JSON.stringify(
      {
        name: PROJECT,
        repo_url: 'git@github.com:MetaMask/metamask-mobile.git',
        static_review: {
          support: { libraries: [{ name: 'perps', root: { env: 'E2E_PERPS_LIBRARY_ROOT' } }] },
        },
        reference_repos: { perps_library: { repo_url: LIBRARY_REPO, local_name: 'perps-lib' } },
      },
      null,
      2,
    )}\n`,
  );
}

function baseRun(id, overrides) {
  return {
    id,
    familyId: id,
    parentRunId: null,
    familyRootTicketOrPr: PR,
    lane: 'production',
    variant: null,
    flowType: 'pr-complete',
    mode: 'autonomous',
    status: 'done',
    project: PROJECT,
    ticketOrPr: PR,
    slotId: null,
    branch: 'fix/perps-order-form',
    taskFile: null,
    steps: [{ name: 'complete', status: 'done' }],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: 'fixture',
      runner: 'scripted',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    // Recent timestamps: the decision inbox only lists runs completed within 48h.
    createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    completedAt: new Date(Date.now() - 3_600_000).toISOString(),
    summary: 'fixture',
    ...overrides,
  };
}

function retroDecision(id) {
  return {
    id,
    type: 'retrospective',
    title: `Review run ${id.slice(0, 8)} — ${PR}`,
    description: 'pr-complete run completed (success)',
    actions: [
      { id: 'accept', label: 'Accept for Learning', style: 'primary' },
      { id: 'rework', label: 'Reject Learning', style: 'secondary' },
      { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
    ],
    createdAt: '2026-09-10T01:00:00.000Z',
  };
}

const TRIAGE = [
  {
    comment_id: 3916065775,
    author_login: 'reviewer-a',
    author_type: 'User',
    source_kind: 'human',
    review_state: 'CHANGES_REQUESTED',
    path: 'app/components/UI/Perps/hooks/usePerpsOrderForm.ts',
    body: 'Late defaults overwrite what the user typed.',
    triage: 'REAL',
    fixed_in_commit: null,
  },
  {
    comment_id: 44,
    author_login: 'cursor[bot]',
    author_type: 'Bot',
    source_kind: 'bugbot',
    path: 'app/components/UI/Perps/hooks/usePerpsOrderForm.ts',
    body: 'Possible null dereference.',
    triage: 'REAL',
    fixed_in_commit: 'deadbeef',
  },
];

const humanCandidate = {
  id: sha256(SOURCE_KEY),
  sourceKey: SOURCE_KEY,
  provider: 'github',
  repository: 'MetaMask/metamask-mobile',
  prNumber: 34865,
  kind: 'review-comment',
  revision: sha256('Late defaults overwrite what the user typed.'),
  bodyRevision: sha256('Late defaults overwrite what the user typed.'),
  authorLogin: 'reviewer-a',
  authorKind: 'human',
  url: COMMENT_URL,
  resolution: { state: 'open', triage: 'REAL' },
  runIds: ['e2e-retro-run'],
  familyChangeRunIds: ['e2e-retro-run'],
  attribution: { kind: 'follow-up-only', note: 'fixture' },
  sources: ['comments-triage'],
};

function draftDecision(id, withDestination) {
  return {
    id,
    type: 'engine_learnings_draft',
    title: 'Learnings routed: domain drafts & holds',
    description: 'fixture',
    actions: [
      ...(withDestination
        ? [{ id: 'landed', label: 'Recorded in canonical library', style: 'primary' }]
        : []),
      { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
    ],
    createdAt: '2026-09-10T02:00:00.000Z',
    payload: {
      kind: 'learnings-draft',
      project: PROJECT,
      sourceRunId: 'e2e-draft-run',
      drafts: [
        {
          id: 'late-defaults-overwrite-user-choice',
          targetPath: 'review/antipatterns.md',
          targetRepo: LIBRARY_REPO,
          symptom: 's',
          cause: 'c',
          action: 'a',
          sourceEntry: '- late defaults overwrite the typed amount',
        },
      ],
      holds: [],
      ...(withDestination
        ? {
            destination: {
              repo: LIBRARY_REPO,
              path: 'review/antipatterns.md',
              library: 'perps',
              source: 'static_review',
            },
          }
        : {}),
      feedbackCandidates: [humanCandidate],
    },
  };
}

function seedRuns() {
  const retroTask = path.join(tasksDir, 'retro');
  mkdirSync(path.join(retroTask, 'artifacts'), { recursive: true });
  writeFileSync(path.join(retroTask, 'TASK.md'), '# fixture task\n');
  writeFileSync(path.join(retroTask, 'artifacts', 'comments-triage.json'), JSON.stringify(TRIAGE));
  writeFileSync(
    path.join(retroTask, 'artifacts', 'learnings.md'),
    '- reviewer caught a late default\n',
  );
  writeFileSync(path.join(retroTask, 'artifacts', 'report.md'), '## Summary\nfixture report\n');

  const runs = [
    baseRun('e2e-retro-run', {
      taskFile: path.join(retroTask, 'TASK.md'),
      decisions: [retroDecision('e2e-retro-decision')],
    }),
    baseRun('e2e-persisted-run', {
      familyId: 'e2e-persisted-run',
      decisions: [
        {
          ...retroDecision('e2e-persisted-decision'),
          // A retrospective the gateway persisted BEFORE the rule landed: its
          // frozen candidate must still show as consumed when read back.
          payload: {
            kind: 'retrospective',
            outcome: 'success',
            whatThisIs: 'fixture',
            actionEffects: [],
            feedbackCandidates: [humanCandidate],
            feedbackSummary: { total: 1, human: 1, bot: 0, unknown: 0, consumed: 0, open: 1 },
          },
        },
      ],
    }),
    baseRun('e2e-drift-run', {
      familyId: 'e2e-drift-run',
      decisions: [retroDecision('e2e-drift-decision')],
    }),
    baseRun('e2e-nodest-run', {
      familyId: 'e2e-nodest-run',
      decisions: [retroDecision('e2e-nodest-decision')],
    }),
    baseRun('e2e-draft-run', {
      familyId: 'e2e-draft-run',
      decisions: [draftDecision('e2e-draft-decision', true)],
    }),
    baseRun('e2e-draft-nodest-run', {
      familyId: 'e2e-draft-nodest-run',
      decisions: [draftDecision('e2e-draft-nodest-decision', false)],
    }),
  ];
  for (const run of runs)
    writeFileSync(path.join(runsDir, `${run.id}.json`), JSON.stringify(run, null, 2));
  return runs;
}

function readRun(id) {
  return JSON.parse(readFileSync(path.join(runsDir, `${id}.json`), 'utf-8'));
}

function exec(command, args, env, { allowFailure = false, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr}`));
    });
  });
}

async function rpc(gatewayUrl, method, params, options = {}) {
  const result = await exec(
    'node',
    [CDP, 'gateway', method, JSON.stringify(params)],
    { FARMSLOT_GATEWAY: gatewayUrl, FARMSLOT_ROOT: REPO },
    options,
  );
  if (result.code !== 0) return { error: result.stderr.trim() || result.stdout.trim() };
  const text = result.stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('gateway did not become healthy in 90s');
}

async function main() {
  seedProject();
  seedRuns();
  const port = await freePort();
  const gatewayUrl = `ws://127.0.0.1:${port}`;
  const ledgerPath = path.join(home, 'state', 'feedback-ledger.json');
  const env = {
    GATEWAY_PORT: String(port),
    GATEWAY_HOST: '127.0.0.1',
    FARMSLOT_ROOT: REPO,
    FARMSLOT_HOME: home,
    FARMSLOT_RUNS_DIR: runsDir,
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_BRANCH_WATCHERS: '0',
    FARMSLOT_LOCAL_HEALTH_POLL: '0',
    FARMSLOT_STARTUP_BRANCH_PREWARM: '0',
    FARMSLOT_DEMO_POOL: '1',
  };
  const gatewayLog = path.join(scratch, 'gateway.log');
  const logFd = (await import('node:fs')).openSync(gatewayLog, 'w');
  const gateway = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(REPO, 'services', 'gateway'),
    env: { ...process.env, ...env },
    stdio: ['ignore', logFd, logFd],
  });
  console.log(`isolated gateway pid=${gateway.pid} port=${port} scratch=${scratch}`);
  if (process.argv.includes('--serve')) {
    await waitForHealth(port, gateway);
    const vitePort = await freePort();
    const vite = spawn('yarn', ['--cwd', 'ui', 'dev'], {
      cwd: path.join(REPO, 'apps', 'command-center'),
      env: { ...process.env, ...env, VITE_PORT: String(vitePort) },
      stdio: ['ignore', logFd, logFd],
    });
    writeFileSync(
      path.join(scratch, 'ports.json'),
      JSON.stringify({
        gatewayPort: port,
        vitePort,
        gatewayUrl,
        uiUrl: `http://localhost:${vitePort}`,
      }),
    );
    console.log(
      `serving: ui=http://localhost:${vitePort} gateway=${gatewayUrl} ports=${path.join(scratch, 'ports.json')} (Ctrl-C to stop)`,
    );
    const stop = () => {
      vite.kill('SIGTERM');
      gateway.kill('SIGTERM');
      rmSync(PROJECT_DIR, { recursive: true, force: true });
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise(() => {});
  }
  try {
    await waitForHealth(port, gateway);

    console.log('\n1. family.observability.get derives feedback candidates for the retrospective');
    const family = await rpc(gatewayUrl, 'family.observability.get', {
      familyId: 'e2e-retro-run',
      project: PROJECT,
    });
    const retroRun = family?.snapshot?.runs?.find((run) => run.runId === 'e2e-retro-run');
    const retroDecisionSnapshot = retroRun?.decisions?.find(
      (decision) => decision.id === 'e2e-retro-decision',
    );
    const payload = retroDecisionSnapshot?.payload;
    check(
      payload?.kind === 'retrospective',
      'retrospective payload derived by the gateway',
      family,
    );
    const candidates = payload?.feedbackCandidates ?? [];
    check(
      candidates.length === 2,
      'two deduplicated candidates (human + bot)',
      candidates.map((c) => c.sourceKey),
    );
    const human = candidates.find((c) => c.authorKind === 'human');
    const bot = candidates.find((c) => c.authorKind === 'bot');
    check(human?.sourceKey === SOURCE_KEY, 'human candidate keyed by provider comment id', human);
    check(
      bot?.resolution?.state === 'fixed' && bot?.resolution?.fixedInCommit === 'deadbeef',
      'bot candidate carries its fix commit',
      bot,
    );
    check(
      human?.attribution?.kind === 'follow-up-only',
      'follow-up-only family is not blamed for the implementation',
      human?.attribution,
    );
    check(!human?.consumedBy, 'candidate has no consumption before the gate', human?.consumedBy);
    check(
      payload?.feedbackSummary?.human === 1 && payload?.feedbackSummary?.bot === 1,
      'summary counts by author kind',
      payload?.feedbackSummary,
    );

    console.log(
      '\n2. run.resolveDecision landed records the ledger; a card without a destination is refused',
    );
    const refused = await rpc(
      gatewayUrl,
      'run.resolveDecision',
      {
        runId: 'e2e-draft-nodest-run',
        decisionId: 'e2e-draft-nodest-decision',
        actionId: 'landed',
      },
      { allowFailure: true },
    );
    check(
      Boolean(refused.error) && /not found|destination/i.test(refused.error),
      'landed refused without a canonical destination',
      refused,
    );
    check(
      !readRun('e2e-draft-nodest-run').decisions[0].resolvedAt,
      'refused card stays pending on disk',
    );

    const landed = await rpc(gatewayUrl, 'run.resolveDecision', {
      runId: 'e2e-draft-run',
      decisionId: 'e2e-draft-decision',
      actionId: 'landed',
    });
    check(
      landed?.run?.decisions?.[0]?.resolvedAction === 'landed',
      'landed resolves the learnings-draft card',
      landed,
    );
    let ledger = null;
    try {
      ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    } catch (err) {
      check(false, 'ledger written under FARMSLOT_HOME/state', String(err));
    }
    const entry = ledger?.entries?.[0];
    check(
      ledger?.entries?.length === 1,
      'exactly one ledger entry for one draft × one candidate',
      ledger,
    );
    check(
      entry?.sourceKey === SOURCE_KEY &&
        entry?.rule === 'late-defaults-overwrite-user-choice' &&
        entry?.destination === `${LIBRARY_REPO}:review/antipatterns.md`,
      'ledger entry binds candidate, rule and destination',
      entry,
    );
    check(
      entry?.decisionId === 'e2e-draft-decision' && entry?.source === 'learnings-draft',
      'ledger entry records the gating decision',
      entry,
    );

    console.log('\n3. the retrospective now shows the candidate as consumed (no re-proposal)');
    const familyAfter = await rpc(gatewayUrl, 'family.observability.get', {
      familyId: 'e2e-retro-run',
      project: PROJECT,
    });
    const humanAfter = familyAfter?.snapshot?.runs
      ?.find((run) => run.runId === 'e2e-retro-run')
      ?.decisions?.find((d) => d.id === 'e2e-retro-decision')
      ?.payload?.feedbackCandidates?.find((c) => c.authorKind === 'human');
    check(
      humanAfter?.consumedBy?.[0]?.rule === 'late-defaults-overwrite-user-choice',
      'candidate consumedBy links the landed rule',
      humanAfter,
    );
    check(
      !humanAfter?.revisedSinceConsumed,
      'unchanged body is not flagged as revised',
      humanAfter,
    );
    check(
      familyAfter?.snapshot?.runs
        ?.find((run) => run.runId === 'e2e-retro-run')
        ?.decisions?.find((d) => d.id === 'e2e-retro-decision')?.payload?.feedbackSummary
        ?.consumed === 1,
      'summary counts the consumption',
      familyAfter?.snapshot?.runs?.[0]?.decisions?.[0]?.payload?.feedbackSummary,
    );
    const persisted = await rpc(gatewayUrl, 'family.observability.get', {
      familyId: 'e2e-persisted-run',
      project: PROJECT,
    });
    const persistedPayload = persisted?.snapshot?.runs?.[0]?.decisions?.find(
      (d) => d.id === 'e2e-persisted-decision',
    )?.payload;
    check(
      persistedPayload?.feedbackCandidates?.[0]?.consumedBy?.[0]?.rule ===
        'late-defaults-overwrite-user-choice' && persistedPayload?.feedbackSummary?.consumed === 1,
      'a retrospective persisted before the rule landed is refreshed from the ledger',
      persistedPayload?.feedbackSummary,
    );
    const listed = await rpc(gatewayUrl, 'decision.list', {});
    const listedPersisted = listed?.decisions?.find((d) => d.id === 'e2e-persisted-decision');
    check(
      listedPersisted?.payload?.feedbackCandidates?.[0]?.consumedBy?.length === 1,
      'decision.list serves the refreshed consumption state too',
      listedPersisted?.payload?.feedbackSummary,
    );
    check(
      readRun('e2e-persisted-run').decisions[0].payload.feedbackSummary.consumed === 0,
      'the stored payload itself is left untouched (refresh is read-side)',
    );

    console.log(
      '\n4. bulk closeout resolves only audited decisions with a recorded destination and matching hash',
    );
    const retroOnDisk = readRun('e2e-retro-run').decisions[0];
    const plan = {
      version: 1,
      decisions: [
        {
          runId: 'e2e-retro-run',
          decisionId: 'e2e-retro-decision',
          decisionHash: await pyDecisionHash(retroOnDisk),
          destination: `${LIBRARY_REPO}:review/antipatterns.md`,
        },
        {
          runId: 'e2e-drift-run',
          decisionId: 'e2e-drift-decision',
          decisionHash: '0'.repeat(64),
          destination: `${LIBRARY_REPO}:review/antipatterns.md`,
        },
        {
          runId: 'e2e-nodest-run',
          decisionId: 'e2e-nodest-decision',
          decisionHash: await pyDecisionHash(readRun('e2e-nodest-run').decisions[0]),
        },
      ],
    };
    const planPath = path.join(scratch, 'plan.json');
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    const receipt = path.join(scratch, 'closeout-receipt.jsonl');
    const scriptEnv = {
      FARMSLOT_ROOT: REPO,
      FARMSLOT_RUNS_DIR: runsDir,
      FARMSLOT_RETRO_DIGEST_DIR: digestDir,
      FARMSLOT_GATEWAY: gatewayUrl,
    };
    const dry = await exec(
      'python3',
      [
        path.join(REPO, 'scripts', 'bulk-resolve-retros.py'),
        '--from-plan',
        planPath,
        '--dry-run',
        '--receipt',
        receipt,
        '--reason',
        'e2e dry',
      ],
      scriptEnv,
    );
    check(
      /previewed: ok=1 skipped=2 failed=0/.test(dry.stdout),
      'dry-run previews one, skips drifted and destination-less',
      dry.stdout,
    );
    check(!readRun('e2e-retro-run').decisions[0].resolvedAt, 'dry-run touches nothing on disk');
    const real = await exec(
      'python3',
      [
        path.join(REPO, 'scripts', 'bulk-resolve-retros.py'),
        '--from-plan',
        planPath,
        '--receipt',
        receipt,
        '--reason',
        'e2e closeout',
      ],
      scriptEnv,
    );
    check(
      /resolved: ok=1 skipped=2 failed=0/.test(real.stdout),
      'real closeout resolves exactly the audited decision',
      real.stdout,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const resolvedRetro = readRun('e2e-retro-run').decisions[0];
    check(
      Boolean(resolvedRetro.resolvedAt) && resolvedRetro.resolvedAction === 'dismiss',
      'gateway persisted the closeout without touching run outcome',
      resolvedRetro,
    );
    check(readRun('e2e-retro-run').status === 'done', 'completed run status intact');
    check(
      !readRun('e2e-drift-run').decisions[0].resolvedAt,
      'drifted decision refused (stale hash)',
    );
    check(
      !readRun('e2e-nodest-run').decisions[0].resolvedAt,
      'decision without recorded destination refused',
    );
    const rows = readFileSync(receipt, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const reasons = rows
      .filter((row) => !row.dryRun)
      .map((row) => `${row.decisionId}:${row.status}:${row.reason}`)
      .sort();
    check(
      JSON.stringify(reasons) ===
        JSON.stringify([
          'e2e-drift-decision:SKIP:changed-since-audit',
          'e2e-nodest-decision:SKIP:no-recorded-destination',
          'e2e-retro-decision:OK:e2e closeout',
        ]),
      'receipt records each audited decision with its reason',
      reasons,
    );
  } finally {
    gateway.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (gateway.exitCode === null) gateway.kill('SIGKILL');
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  }
  console.log(`\ngateway log: ${gatewayLog}`);
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\nall feedback-loop assertions held');
  rmSync(scratch, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  rmSync(PROJECT_DIR, { recursive: true, force: true });
  process.exit(2);
});
