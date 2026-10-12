#!/usr/bin/env node
// A private production gateway, immutable Git source and isolated provider sink.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { proofRPC, startProofReadProxy, stopProofGateway, waitForProof } from './proof-gateway.mjs';
import { seedAndroidGatewayProfile, seedIOSGatewayProfile } from './seed-ios-gateway-profile.mjs';
import {
  openAndroidDevClient,
  openAndroidUrl,
  openSimulatorDevClient,
  waitForSimulatorRecipeBridge,
} from './simulator-dev-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const proof =
  process.env.REVIEW_CURATION_PROOF_DIR ?? path.join(os.tmpdir(), 'review-curation-proof');
const stateFile = path.join(proof, 'state.json');
const simulator = process.env.IOS_SIMULATOR ?? process.env.SIMULATOR;
const platform = process.env.PLATFORM ?? 'ios';
const serial = process.env.ADB_SERIAL ?? process.env.ANDROID_SERIAL;
const bundle = process.env.FARMSLOT_RECIPE_APP_ID ?? 'net.siteed.farmslot.development';
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
};
const rpc = (method, params) => proofRPC(root, state().port, method, params);
const evidence = (name, data) =>
  write(path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR ?? proof, `${name}.json`), data);
const stop = () => {
  if (fs.existsSync(stateFile)) {
    const owned = state();
    if (owned.refreshPid) stopProofGateway(owned.refreshPid);
    if (owned.writerPid) stopProofGateway(owned.writerPid);
    if (owned.pid) stopProofGateway(owned.pid);
    fs.rmSync(owned.farm, { recursive: true, force: true });
  }
};
const savedContext = process.env.REVIEW_PROOF_CONTEXT === 'saved';
const report =
  'Recommendation: REQUEST_CHANGES\n\n## Summary\nOriginal saved review report.' +
  (savedContext
    ? '\n' + 'Complete retained report.\n'.repeat(120) + 'FINAL SAVED REPORT LINE'
    : '');
const findings = [
  { path: 'src/example.ts', line: 2, body: 'First exact finding', severity: 'must_fix' },
  { path: 'src/example.ts', line: 3, body: 'Second exact finding', severity: 'suggestion' },
];
const phase = process.argv[2];

if (phase === 'serve') {
  await import(path.join(root, 'services/gateway/src/index.ts'));
  const { createRun, updateRun, getRun, persistRunNow } = await import(
    path.join(root, 'services/gateway/src/runs/store.ts')
  );
  const { holdWorkspaceReview } = await import(
    path.join(root, 'services/gateway/src/review-workspaces/gate.ts')
  );
  const { executeReviewGate } = await import(
    path.join(root, 'services/gateway/src/run-engine/review-gate.ts')
  );
  const { publishWorkspaceReview } = await import(
    path.join(root, 'services/gateway/src/review-publication/provider.ts')
  );
  const { broadcastEvent } = await import(path.join(root, 'services/gateway/src/server.ts'));
  const { setEngineDecisionRuntime } = await import(
    path.join(root, 'services/gateway/src/run-engine/engine-decisions.ts')
  );
  const { setReviewGateBroadcast } = await import(
    path.join(root, 'services/gateway/src/run-engine/review-gate.ts')
  );
  setEngineDecisionRuntime({ broadcast: broadcastEvent, stepToStatus: {} });
  setReviewGateBroadcast(broadcastEvent);
  const s = state();
  if (savedContext)
    startProofReadProxy({ port: s.port + 1, gatewayPort: s.port, directory: proof });
  const snapshot = {
    source: 'github-pr',
    headSha: s.head,
    baseSha: s.base,
    capturedAt: new Date().toISOString(),
    diffHash: 'fixture',
  };
  const result = {
    reviewMd: report,
    lineComments: findings,
    recommendation: 'REQUEST_CHANGES',
    reviewSnapshot: snapshot,
  };
  const runs = [];
  for (const kind of ['workspace', 'slot', 'empty']) {
    const run = createRun(
      {
        flowType: 'review-pr',
        project: 'review-curation',
        ticketOrPr: 'example/app#42',
        mode: 'interactive',
        transport: 'native',
        ...(kind === 'slot' ? { slotId: 'curation-slot' } : {}),
      },
      { nativeOwnerPrincipalId: 'local-admin' },
    );
    const task = path.join(s.checkout, 'tasks', kind);
    fs.mkdirSync(path.join(task, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(task, 'inputs'), { recursive: true });
    fs.writeFileSync(path.join(task, 'TASK.md'), '# Private review proof\n');
    fs.writeFileSync(path.join(task, 'artifacts/review.md'), report);
    write(path.join(task, 'artifacts/line-comments.json'), {
      recommendation: result.recommendation,
      comments: findings,
    });
    write(path.join(task, 'inputs/commit.json'), {
      source: 'github-pr',
      headSha: s.head,
      baseSha: s.base,
      capturedAt: snapshot.capturedAt,
    });
    fs.writeFileSync(
      path.join(task, 'inputs/diff.txt'),
      execFileSync('git', ['diff', s.base, s.head], { cwd: s.checkout }),
    );
    updateRun(run.id, {
      status: 'blocked',
      prNumber: 42,
      taskFile: path.join(task, 'TASK.md'),
      nativeOwnerPrincipalId: 'local-admin',
      createdByPrincipalId: 'local-admin',
      reviewResult: structuredClone(result),
      reviewQaContract: { version: 1 },
      ...(kind !== 'slot'
        ? {
            reviewWorkspace: {
              workspaceId: run.id,
              checkoutPath: path.join(s.farm, 'workspaces', run.id, 'checkout'),
              executionNodeId: 'local',
              machine: 'fixture',
              cleanedAt: snapshot.capturedAt,
            },
            reviewWorkspaceSubject: {
              repository: 'example/app',
              repositoryUrl: 'https://github.com/example/app.git',
              headSha: s.head,
              baseSha: s.base,
            },
          }
        : {}),
    });
    const completion =
      kind === 'slot'
        ? executeReviewGate(run.id)
        : holdWorkspaceReview(run.id).then(async ({ action }) => {
            if (action !== 'post') return;
            updateRun(run.id, { status: 'done' });
            await persistRunNow(getRun(run.id));
            let receipt;
            await publishWorkspaceReview({
              run: getRun(run.id),
              ownerId: 'local-admin',
              account: { host: 'github.com', login: 'reviewer' },
              pr: { host: 'github.com', repo: 'example/app', number: 42 },
              authorize: async () => {},
              readReceipt: async () => receipt,
              saveReceipt: async (next) => {
                receipt = next;
                updateRun(run.id, {
                  reviewPublication: { ...getRun(run.id).reviewPublication, receipt: next },
                });
                await persistRunNow(getRun(run.id));
              },
            });
          });
    completion
      .then(async () => {
        updateRun(run.id, { status: 'done' });
        await persistRunNow(getRun(run.id));
        broadcastEvent('run.updated', { run: getRun(run.id) });
      })
      .catch((error) => {
        console.error(error);
        updateRun(run.id, { error: error.message });
      });
    const decision = await waitForProof(() =>
      getRun(run.id).decisions.find(
        (item) => item.type === 'engine_review_posting' && !item.resolvedAt,
      ),
    );
    await persistRunNow(getRun(run.id));
    runs.push({ kind, runId: run.id, decisionId: decision.id, task });
  }
  if (savedContext) {
    for (const kind of ['auto', 'historical', 'legacy']) {
      const run = createRun(
        {
          flowType: 'review-pr',
          project: 'review-curation',
          ticketOrPr: 'example/app#42',
          transport: 'native',
        },
        { nativeOwnerPrincipalId: 'local-admin' },
      );
      const payload = { kind: 'review', ...result, recommendation: 'HISTORICAL REQUEST_CHANGES' };
      updateRun(run.id, {
        status: kind === 'auto' ? 'blocked' : 'done',
        reviewAutoFinish: kind === 'auto',
        reviewResult:
          kind === 'auto'
            ? { ...structuredClone(result), recommendation: 'AUTO REQUEST_CHANGES' }
            : undefined,
        decisions:
          kind === 'historical'
            ? [
                {
                  id: 'history-' + run.id,
                  type: 'engine_review_posting',
                  title: 'Saved historical review',
                  description: '',
                  createdAt: snapshot.capturedAt,
                  resolvedAt: snapshot.capturedAt,
                  resolvedAction: 'dismiss',
                  actions: [],
                  payload,
                },
              ]
            : [],
      });
      if (kind === 'auto') {
        assert.equal((await holdWorkspaceReview(run.id)).reason, 'explicit-auto-finish');
        updateRun(run.id, { status: 'done' });
      }
      await persistRunNow(getRun(run.id));
      runs.push({ kind, runId: run.id });
    }
  }
  if (savedContext) {
    // A notification/deep link can name a review older than the mobile history window.
    for (let index = 0; index < 81; index++) {
      const padding = createRun(
        {
          flowType: 'dev',
          project: 'review-curation',
          ticketOrPr: `history-padding-${index}`,
          transport: 'native',
        },
        { nativeOwnerPrincipalId: 'local-admin' },
      );
      updateRun(padding.id, { status: 'done' });
      await persistRunNow(getRun(padding.id));
    }
  }
  write(stateFile, { ...state(), runs });
} else if (phase === 'setup') {
  stop();
  const farm = fs.mkdtempSync(path.join(os.tmpdir(), 'curation-farm-'));
  fs.mkdirSync(proof, { recursive: true });
  if (savedContext) {
    for (const name of ['phone-rpc.jsonl', 'held-reads.jsonl'])
      fs.writeFileSync(path.join(proof, name), '', { mode: 0o600 });
    write(path.join(proof, 'read-delay.json'), {});
  }
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, farm], { stdio: 'pipe' });
  for (const name of ['scripts', 'services', 'packages', 'node_modules'])
    fs.symlinkSync(path.join(root, name), path.join(farm, name));
  fs.writeFileSync(path.join(farm, 'CLAUDE.md'), '# Private review curation proof\n');
  const checkout = path.join(farm, 'source');
  fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
  git('init');
  git('config', 'user.name', 'Review fixture');
  git('config', 'user.email', 'fixture@example.test');
  const commit = (value) => {
    fs.writeFileSync(path.join(checkout, 'src/example.ts'), value);
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'test: capture source');
    return git('rev-parse', 'HEAD');
  };
  const base = commit('before\nbase value\nbase second\nafter\n');
  const head = commit('before\nREVIEWED VALUE\nREVIEWED SECOND\nafter\n');
  fs.writeFileSync(
    path.join(checkout, 'src/example.ts'),
    'before\nMUTABLE CHECKOUT VALUE\nMUTABLE SECOND\nafter\n',
  );
  const identity = {
    owner: 'local-admin',
    project: 'review-curation',
    repositoryUrl: 'https://github.com/example/app.git',
  };
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const cache = path.join(farm, 'repositories', key);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  execFileSync('git', ['clone', '--bare', checkout, cache], { stdio: 'pipe' });
  write(cache + '.json', identity);
  write(path.join(farm, 'pool/fixture.json'), {
    schema_version: 2,
    machine: 'fixture',
    project: 'review-curation',
    platform: 'web',
    host: 'localhost',
    os: 'macos',
    ssh_user: 'fixture',
    slots: [{ id: 'curation-slot', repo: checkout, session: 'curation-proof', resources: {} }],
  });
  write(path.join(farm, 'projects/review-curation/project.json'), {
    name: 'review-curation',
    default_branch: 'main',
    task_dir: 'tasks',
    ci: { repo: 'example/app' },
    workflowDefaults: { 'review-pr': { publishReview: true } },
  });
  const now = new Date().toISOString();
  write(path.join(farm, '.pr-rules.json'), {
    version: 1,
    teams: [
      {
        id: 'curation-proof-team',
        ownerId: 'local-admin',
        revision: 1,
        createdAt: now,
        updatedAt: now,
        config: {
          name: 'Private review proof',
          account: { host: 'github.com', login: 'reviewer' },
          sources: [{ kind: 'repository', repo: 'example/app' }],
          predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
          repositories: [
            {
              repo: 'example/app',
              project: 'review-curation',
              reviewProfile: 'standard',
              excludedLabels: [],
            },
          ],
          execution: {
            workspacePolicy: { kind: 'exact', machine: 'fixture' },
            transport: 'native',
            models: [
              { runner: 'cursor', model: 'cursor-grok-4.6-xhigh', effort: null, mode: 'cold' },
            ],
          },
          githubTeams: [],
          notificationPrincipalIds: [],
        },
      },
    ],
    rules: [],
    intents: [],
  });
  const provider = path.join(proof, 'provider.json');
  write(provider, {
    head,
    base,
    author: 'author',
    posts: 0,
    reviews: [],
    files: [
      {
        filename: 'src/example.ts',
        patch:
          '@@ -1,4 +1,4 @@\n before\n-base value\n-base second\n+REVIEWED VALUE\n+REVIEWED SECOND\n after',
      },
    ],
  });
  fs.mkdirSync(path.join(farm, 'bin'));
  fs.symlinkSync(
    path.join(root, 'scripts/runner-validation/review-provider-fixture.cjs'),
    path.join(farm, 'bin/gh'),
  );
  fs.writeFileSync(
    path.join(farm, 'bin/tmux'),
    '#!/bin/sh\necho "Private review proof has no tmux" >&2\nexit 1\n',
    { mode: 0o700 },
  );
  const port = Number(process.env.REVIEW_CURATION_GATEWAY_PORT ?? 18797);
  write(stateFile, { farm, checkout, provider, head, base, port });
  const log = fs.openSync(path.join(proof, 'gateway.log'), 'a', 0o600);
  const child = spawn(
    path.join(root, 'node_modules/.bin/tsx'),
    [
      '--tsconfig',
      path.join(root, 'services/gateway/tsconfig.json'),
      fileURLToPath(import.meta.url),
      'serve',
    ],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        PATH: path.join(farm, 'bin') + path.delimiter + process.env.PATH,
        PUBLICATION_FIXTURE_STATE: provider,
        REVIEW_CURATION_PROOF_DIR: proof,
        FARMSLOT_ROOT: farm,
        FARMSLOT_HOME: path.join(farm, 'home'),
        FARMSLOT_PROJECTS_DIR: path.join(farm, 'projects'),
        FARMSLOT_POOL_DIR: path.join(farm, 'pool'),
        FARMSLOT_RUNS_DIR: path.join(farm, 'runs'),
        FARMSLOT_DISPATCH_QUEUE_FILE: path.join(farm, 'queue.json'),
        FARMSLOT_BACKLOG_FILE: path.join(farm, 'backlog.json'),
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(port),
        FARMSLOT_GATEWAY_TOKEN: '',
        FARMSLOT_GATEWAY_PASSWORD: '',
        FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'local-admin',
        FARMSLOT_DISABLE_ORCHESTRATION: '1',
        FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      },
    },
  );
  fs.closeSync(log);
  child.unref();
  write(stateFile, { ...state(), pid: child.pid });
  try {
    await waitForProof(() => {
      if (child.exitCode !== null)
        throw new Error(`Private gateway exited ${child.exitCode}; inspect gateway.log`);
      return state().runs?.length === (savedContext ? 6 : 3);
    }, 90_000);
    const seedProfile = platform === 'android' ? seedAndroidGatewayProfile : seedIOSGatewayProfile;
    seedProfile({
      simulator,
      serial,
      bundleId: bundle,
      seenVersion: JSON.parse(
        fs.readFileSync(path.join(root, 'apps/companion/package.json'), 'utf8'),
      ).version,
      profile: {
        id: 'review-curation',
        name: 'Review curation proof',
        url: `ws://127.0.0.1:${port + (savedContext ? 1 : 0)}`,
        kind: 'lan',
        authMode: 'none',
      },
    });
  } catch (error) {
    stopProofGateway(child.pid);
    throw error;
  }
  if (savedContext) {
    for (const entry of state().runs.filter((item) => item.decisionId)) {
      const decision = rpc('run.get', { runId: entry.runId }).run.decisions.find(
        (item) => item.id === entry.decisionId,
      );
      const { reviewPostingFingerprint } = await import('@farmslot/protocol');
      rpc('run.resolveDecision', {
        runId: entry.runId,
        decisionId: entry.decisionId,
        actionId: entry.kind === 'workspace' ? 'post' : 'dismiss',
        selectionData: {
          recommendation: 'APPROVE',
          includedIndices: [],
          includeEvidence: false,
          reviewFingerprint: reviewPostingFingerprint(decision.payload),
        },
      });
      await waitForProof(() => rpc('run.get', { runId: entry.runId }).run.status === 'done');
    }
    const listed = rpc('run.list', { limit: 200 }).runs;
    const historical = listed.find(
      (run) => run.id === state().runs.find((entry) => entry.kind === 'historical').runId,
    );
    assert(historical.decisions[0].payloadTrimmed.includes('reviewMd'));
    assert(
      !rpc('run.list', { limit: 80, sort: 'newest' }).runs.some((run) => run.id === historical.id),
      'Saved review must be outside the mobile history window',
    );
    const baseline = state().runs.map((entry) => ({
      ...entry,
      run: rpc('run.get', { runId: entry.runId }).run,
    }));
    write(path.join(proof, 'saved-baseline.json'), {
      baseline,
      provider: JSON.parse(fs.readFileSync(provider, 'utf8')),
    });
    evidence('saved-baseline', { baseline, historicalList: historical });
    for (const value of [port, port + 1])
      execFileSync('adb', ['-s', serial, 'reverse', `tcp:${value}`, `tcp:${value}`]);
  }
  evidence('reviewed-source', { head, checkout: git('status', '--porcelain') });
} else if (phase === 'saved-background') {
  write(path.join(proof, 'phone-disconnected.json'), { runIds: [] });
  execFileSync('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  const runId = state().runs.find((entry) => entry.kind === 'historical').runId;
  await waitForProof(() =>
    JSON.parse(
      fs.readFileSync(path.join(proof, 'phone-disconnected.json'), 'utf8'),
    ).runIds.includes(runId),
  );
  evidence('saved-background-disconnect', {
    runId,
    outsideHistory: true,
    transportDisconnected: true,
  });
} else if (phase === 'saved-foreground') {
  execFileSync('adb', [
    '-s',
    serial,
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    '-n',
    `${bundle}/.MainActivity`,
  ]);
  await waitForSimulatorRecipeBridge({ platform: 'android' });
} else if (phase === 'saved-arm') {
  const entry = state().runs.find((item) => item.kind === 'historical');
  write(path.join(proof, 'read-delay.json'), { runId: entry.runId });
} else if (phase === 'saved-held') {
  await waitForProof(
    () =>
      fs.existsSync(path.join(proof, 'held-reads.jsonl')) &&
      fs.readFileSync(path.join(proof, 'held-reads.jsonl'), 'utf8').trim(),
  );
} else if (phase === 'saved-release') {
  write(path.join(proof, 'read-delay.json'), {});
} else if (phase === 'saved-verify') {
  const before = JSON.parse(fs.readFileSync(path.join(proof, 'saved-baseline.json'), 'utf8'));
  for (const { runId, run } of before.baseline) {
    const after = rpc('run.get', { runId }).run;
    for (const field of ['reviewResult', 'decisions', 'reviewPublication', 'status', 'updatedAt'])
      assert.deepEqual(after[field], run[field], `Reading changed ${runId}.${field}`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(state().provider, 'utf8')), before.provider);
  const requests = fs
    .readFileSync(path.join(proof, 'phone-rpc.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(requests.some((request) => request.method === 'run.get'));
  assert(
    !requests.some((request) =>
      [
        'run.resolveDecision',
        'run.refreshReviewGate',
        'prReview.publish',
        'decision.resolve',
      ].includes(request.method),
    ),
  );
  const heldReplies = fs
    .readFileSync(path.join(proof, 'held-reads.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    heldReplies.some(
      (reply) => reply.runId === state().runs.find((entry) => entry.kind === 'historical').runId,
    ),
  );
  evidence('saved-read-only', {
    unchanged: true,
    methods: [...new Set(requests.map((request) => request.method))],
    heldReplies,
  });
  console.log('PASS saved reader, full hydration, unchanged store and provider');
} else if (phase.startsWith('saved-open-')) {
  await waitForSimulatorRecipeBridge({ platform: 'android' });
  const entry = state().runs.find((item) => item.kind === phase.slice(11));
  assert(entry, 'Unknown saved review case');
  openAndroidUrl(serial, bundle, `farmslot-development://run/${entry.runId}`);
} else if (phase === 'relaunch') {
  if (platform === 'android') await openAndroidDevClient(serial, bundle);
  else await openSimulatorDevClient(simulator);
} else if (phase === 'bridge-ready') await waitForSimulatorRecipeBridge({ platform });
else if (phase.startsWith('open-')) {
  const entry = state().runs.find((item) => item.kind === phase.slice(5));
  const url = `farmslot-development://decision/${entry.decisionId}?runId=${entry.runId}`;
  if (platform === 'android')
    execFileSync('adb', [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      url,
      '-p',
      bundle,
    ]);
  else execFileSync('xcrun', ['simctl', 'openurl', simulator, url]);
} else if (phase === 'revise-slot') {
  const entry = state().runs.find((item) => item.kind === 'slot');
  const before = rpc('run.get', { runId: entry.runId }).run.decisions.find(
    (item) => item.id === entry.decisionId,
  );
  write(path.join(proof, 'slot-before-refresh.json'), before);
  write(path.join(entry.task, 'artifacts/line-comments.json'), {
    recommendation: 'REQUEST_CHANGES',
    comments: [...findings].reverse(),
  });
} else if (phase === 'refresh-slot') {
  const entry = state().runs.find((item) => item.kind === 'slot');
  const run = rpc('run.refreshReviewGate', { runId: entry.runId }).run;
  const decision = run.decisions.find((item) => item.id === entry.decisionId);
  assert.deepEqual(decision.payload.lineComments, [...findings].reverse());
  assert.equal(decision.resolvedAt, undefined);
  evidence('slot-refreshed', decision);
} else if (phase === 'slot-still-pending') {
  const entry = state().runs.find((item) => item.kind === 'slot');
  const run = rpc('run.get', { runId: entry.runId }).run;
  const decision = run.decisions.find((item) => item.id === entry.decisionId);
  assert.equal(decision.resolvedAt, undefined);
  assert.deepEqual(decision.payload.lineComments, [...findings].reverse());
  assert.equal(JSON.parse(fs.readFileSync(state().provider, 'utf8')).slotComments, undefined);
  evidence('stale-confirmation-pending', decision);
} else if (phase === 'arm-slot-race') {
  const entry = state().runs.find((item) => item.kind === 'slot');
  const fifo = path.join(entry.task, 'artifacts/review.md');
  fs.renameSync(fifo, fifo + '.accepted');
  execFileSync('mkfifo', [fifo]);
  const control = path.join(proof, 'release-worker-report.txt');
  const ready = path.join(proof, 'worker-report-waiting.json');
  fs.rmSync(control, { force: true });
  fs.rmSync(ready, { force: true });
  const writer = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs');
const [fifo,control,ready]=process.argv.slice(1); const fd=fs.openSync(fifo,'r+');
fs.writeSync(fd,Buffer.from([10])); fs.writeFileSync(ready,JSON.stringify({pid:process.pid})); const until=Date.now()+60000;
const poll=setInterval(()=>{if(fs.existsSync(control)){fs.writeSync(fd,fs.readFileSync(control));fs.closeSync(fd);clearInterval(poll);}else if(Date.now()>until){fs.closeSync(fd);clearInterval(poll);process.exitCode=1;}},25);`,
      fifo,
      control,
      ready,
    ],
    { detached: true, stdio: 'ignore' },
  );
  writer.unref();
  write(stateFile, { ...state(), writerPid: writer.pid, fifo, control });
  await waitForProof(() => {
    if (writer.exitCode !== null) throw new Error(`Worker report holder exited ${writer.exitCode}`);
    return fs.existsSync(ready);
  });
  const logFile = path.join(proof, 'refresh-race.log');
  const fd = fs.openSync(logFile, 'w', 0o600);
  const refresh = spawn(
    process.execPath,
    [
      path.join(root, 'apps/command-center/scripts/cdp.mjs'),
      'gateway',
      'run.refreshReviewGate',
      JSON.stringify({ runId: entry.runId }),
    ],
    {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        FARMSLOT_GATEWAY: `ws://127.0.0.1:${state().port}`,
        FARMSLOT_RPC_TIMEOUT_MS: '45000',
      },
    },
  );
  fs.closeSync(fd);
  refresh.unref();
  write(stateFile, { ...state(), refreshPid: refresh.pid, fifo, refreshLog: logFile });
  await waitForProof(() => {
    const queuedBytes = execFileSync(
      'python3',
      [
        '-c',
        'import os,fcntl,termios,array,sys;fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NONBLOCK);n=array.array("i",[0]);fcntl.ioctl(fd,termios.FIONREAD,n,True);os.close(fd);print(n[0])',
        fifo,
      ],
      { encoding: 'utf8' },
    );
    return Number(queuedBytes.trim()) === 0;
  });
  evidence('refresh-in-flight', { runId: entry.runId, fifo, queuedBytes: 0 });
} else if (phase === 'release-slot-race') {
  const s = state(),
    entry = s.runs.find((item) => item.kind === 'slot');
  const decision = rpc('run.get', { runId: entry.runId }).run.decisions.find(
    (item) => item.id === entry.decisionId,
  );
  assert.equal(decision.resolvedAction, 'post');
  // A real worker write completes a refresh started before acceptance, while
  // the legacy formal poster must keep consuming its accepted report snapshot.
  fs.writeFileSync(
    s.control,
    'Recommendation: APPROVE\n\n## Summary\nChanged worker report after acceptance.',
  );
  await waitForProof(() =>
    fs.readFileSync(s.refreshLog, 'utf8').includes('Review changed during refresh'),
  );
  fs.unlinkSync(s.fifo);
  fs.writeFileSync(
    s.fifo,
    'Recommendation: APPROVE\n\n## Summary\nChanged worker report after acceptance.',
  );
  write(path.join(entry.task, 'artifacts/line-comments.json'), {
    recommendation: 'APPROVE',
    comments: [],
  });
  const current = rpc('run.get', { runId: entry.runId }).run.decisions.find(
    (item) => item.id === entry.decisionId,
  );
  assert.deepEqual(current.payload, decision.payload);
  assert.deepEqual(current.selectionData, decision.selectionData);
  evidence('refresh-race-refused', {
    decision: current,
    error: fs.readFileSync(s.refreshLog, 'utf8'),
  });
} else if (phase.startsWith('verify-')) {
  const kind = phase.slice(7),
    entry = state().runs.find((item) => item.kind === kind);
  const run = await waitForProof(() => {
    const value = rpc('run.get', { runId: entry.runId }).run;
    if (value.error) throw new Error(value.error);
    return value.status === 'done' &&
      (kind === 'slot' || value.reviewPublication?.receipt?.state === 'published')
      ? value
      : null;
  });
  const decision = run.decisions.find((item) => item.id === entry.decisionId);
  assert.equal(decision.resolvedAction, 'post');
  assert.deepEqual(decision.selectionData.includedIndices, kind === 'empty' ? [] : [1]);
  assert.equal(decision.payload.reviewMd, report);
  const sink = JSON.parse(fs.readFileSync(state().provider, 'utf8'));
  const comments = kind === 'slot' ? sink.slotComments : sink.payload.comments;
  assert.equal(comments?.length ?? 0, kind === 'empty' ? 0 : 1);
  if (kind !== 'empty') {
    assert.equal(
      comments[0].body,
      kind === 'slot'
        ? '**must fix** — First exact finding'
        : '**Suggestion.** Second exact finding',
    );
    assert.equal(comments[0].path, 'src/example.ts');
    assert.equal(Number(comments[0].line), kind === 'slot' ? 2 : 3);
  }
  if (kind === 'slot') {
    assert.match(sink.slotReport, /Original saved review report/);
    assert.match(sink.slotReport, /First exact finding/);
    assert.doesNotMatch(
      sink.slotReport,
      /Second exact finding|Changed worker report after acceptance/,
    );
    assert.equal(sink.slotEvent, 'REQUEST_CHANGES');
    assert.equal(sink.slotCommit, state().head);
  } else assert.equal(sink.payload.commit_id, state().head);
  evidence(`${kind}-publication`, { run, sink });
  console.log(
    JSON.stringify({
      kind,
      reviewedSha: state().head,
      selectedIndices: decision.selectionData.includedIndices,
      outgoing: comments ?? [],
      formalEvent: kind === 'slot' ? sink.slotEvent : sink.payload.event,
    }),
  );
} else if (phase === 'stop') stop();
else throw new Error(`Unknown curation proof phase ${phase}`);
