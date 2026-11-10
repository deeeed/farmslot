import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'scripts/backfill-native-reviewer-usage.mts');
const legacy = {
  runner: 'claude',
  runnerSessionId: 'review-conversation',
  runnerSessionPath: null,
  source: 'unavailable',
  measuredAt: '2026-11-01T00:00:00Z',
  error: 'Native reviewer usage accounting is unavailable',
  retainedNote: 'keep this',
};

test('offline backfill defaults to read-only, refuses the live owner, preserves data and is idempotent', async (t) => {
  const f = await mkdtemp(path.join(os.tmpdir(), 'reviewer-backfill-'));
  t.after(() => rm(f, { recursive: true, force: true }));
  const farm = path.join(f, 'farm');
  const runs = path.join(f, 'runs');
  const home = path.join(f, 'home');
  const repo = path.join(f, 'repo');
  const cli = path.join(f, 'cli');
  for (const directory of [
    path.join(farm, '.runs'),
    path.join(farm, 'pool'),
    runs,
    home,
    repo,
    path.join(cli, 'bin'),
    path.join(cli, 'node_modules/@farmslot/slot-config'),
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(path.join(cli, 'bin/farmslot'), '#!/bin/false\n', { mode: 0o755 });
  await writeFile(
    path.join(cli, 'node_modules/@farmslot/slot-config/package.json'),
    JSON.stringify({
      name: '@farmslot/slot-config',
      type: 'module',
      exports: './session-usage.ts',
    }),
  );
  await symlink(
    path.join(root, 'packages/slot-config/src/session-usage.ts'),
    path.join(cli, 'node_modules/@farmslot/slot-config/session-usage.ts'),
  );
  await writeFile(
    path.join(farm, 'pool/local.json'),
    JSON.stringify({ machine: 'fixture', host: 'localhost', slots: [{ id: 'slot', repo }] }),
  );
  const transcript = path.join(
    home,
    '.claude/projects',
    repo.replace(/[^a-zA-Z0-9]/g, '-'),
    'review-conversation.jsonl',
  );
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'assistant',
      sessionId: 'review-conversation',
      message: {
        id: 'one',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
      },
    }) + '\n',
  );
  await writeFile(
    transcript.replace('review-conversation.jsonl', 'earlier-conversation.jsonl'),
    (await readFile(transcript, 'utf8')).replaceAll('review-conversation', 'earlier-conversation'),
  );
  const document = {
    id: 'run',
    slotId: 'slot',
    status: 'done',
    agentContexts: [
      {
        role: 'review',
        reviewId: 'review-lineage',
        runner: 'claude',
        runnerSessionId: 'review-conversation',
        nativeSession: { sessionId: 'host', ownerPrincipalId: 'owner', executionNodeId: 'local' },
      },
    ],
    steps: [
      {
        name: 'write-task',
        outputs: {
          usage: legacy,
          summaryLlm: {
            provider: 'openai',
            model: 'fixture',
            inputTokens: 1,
            outputTokens: 2,
            durationMs: 3,
          },
        },
      },
    ],
    engineState: { publishGate: { reviews: [{ id: 'review', usage: legacy }] } },
    learning: { proof3: ['original proof'], 'pipeline-review-loop-1': { verdict: 'pass' } },
    custom: ['do not drop'],
  };
  for (const status of ['complete', 'failed'])
    document.agentContexts.push({
      ...document.agentContexts[0],
      status,
      runnerSessionId: 'earlier-conversation',
      customContextField: 'preserve',
    });
  document.agentContexts[0].usage = { ...legacy, customReceiptNote: 'preserve receipt note' };
  document.agentContexts.push({
    ...document.agentContexts[0],
    status: 'failed',
    usage: { ...legacy, customReceiptNote: 'separate context note' },
  });
  const metricOnlyPath = transcript.replace(
    'review-conversation.jsonl',
    'metric-only-conversation.jsonl',
  );
  await writeFile(
    metricOnlyPath,
    (await readFile(transcript, 'utf8')).replaceAll(
      'review-conversation',
      'metric-only-conversation',
    ),
  );
  document.flowType = 'dev';
  document.metrics = {
    runner: 'claude',
    runnerSessionId: 'metric-only-conversation',
    runnerSessionPath: metricOnlyPath,
  };
  document.agentContexts.splice(3, 0, {
    role: 'dev',
    runner: 'claude',
    status: 'complete',
    runnerSessionId: 'metric-only-conversation',
  });
  document.agentContexts.push({
    role: 'dev',
    runner: 'claude',
    status: 'launching',
    runnerSessionId: null,
    nativeSession: {
      sessionId: 'pending-host',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
    },
  });
  const staticRepo = path.join(repo, 'review/source');
  const staticTask = path.join(repo, 'review/task');
  await mkdir(staticRepo, { recursive: true });
  await mkdir(staticTask, { recursive: true });
  const piPath = path.join(home, '.pi/agent/sessions/review/2026-11-10_static-session.jsonl');
  await mkdir(path.dirname(piPath), { recursive: true });
  await writeFile(
    piPath,
    [
      { type: 'session', id: 'static-session', timestamp: '2026-11-10T00:00:01Z', cwd: staticRepo },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: `Read ${staticTask}/TASK.md` }] },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          model: 'glm-5p3-flash',
          usage: { input: 10, output: 20, cacheRead: 30, cost: { total: 0.001 } },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const staticReview = {
    id: 'static-run',
    status: 'failed',
    createdAt: '2026-11-10T00:00:00Z',
    steps: [],
    flowType: 'review-pr',
    transport: 'tmux',
    slotId: null,
    project: 'fixture',
    metrics: { nudgeCount: 0, runner: 'pi', model: 'litellm/glm-5p3-flash' },
    reviewWorkspace: {
      workspaceId: 'review',
      machine: 'remote-fixture',
      executionNodeId: 'remote-fixture',
      checkoutPath: staticRepo,
      taskPath: staticTask,
      artifactPath: path.join(staticTask, 'artifacts'),
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        runId: 'static-run',
        runner: 'pi',
        model: 'litellm/glm-5p3-flash',
        effort: 'high',
        slotId: null,
        status: 'failed',
        startedAt: '2026-11-10T00:00:00Z',
        completedAt: '2026-11-10T00:01:00Z',
        target: { session: 'owned-review', target: 'owned-review' },
      },
    ],
    learning: { retained: 'do not change' },
  };
  await writeFile(
    path.join(farm, 'pool/remote.json'),
    JSON.stringify({
      machine: 'remote-fixture',
      host: 'offline-review.invalid',
      ssh_user: 'tester',
      platform: 'cli',
      os: process.platform,
      project: 'fixture',
      slots: [],
    }),
  );
  const sshMarker = path.join(f, 'offline-ssh');
  await writeFile(
    path.join(cli, 'bin/ssh'),
    `#!/bin/sh
[ "$1" = -- ] || exit 71
case "$2" in offline-review.invalid|tester@offline-review.invalid) shift 2;; *) exit 72;; esac
printf x >> '${sshMarker}'
exec bash -c "$1"
`,
    { mode: 0o755 },
  );
  const gapDocuments = [];
  for (const kind of ['missing', 'ambiguous']) {
    const gapRepo = path.join(repo, kind, 'source');
    const gapTask = path.join(repo, kind, 'task');
    await mkdir(gapRepo, { recursive: true });
    const gap = {
      ...staticReview,
      id: kind,
      reviewWorkspace: {
        ...staticReview.reviewWorkspace,
        checkoutPath: gapRepo,
        taskPath: gapTask,
      },
      agentContexts: staticReview.agentContexts.map((context) => ({ ...context, runId: kind })),
    };
    const bytes = JSON.stringify(gap);
    const file = path.join(runs, kind + '.json');
    await writeFile(file, bytes);
    gapDocuments.push({ file, bytes });
    if (kind === 'ambiguous')
      for (const id of ['first', 'second']) {
        await writeFile(
          path.join(home, '.pi/agent/sessions/review', id + '.jsonl'),
          [
            { type: 'session', id, timestamp: '2026-11-10T00:00:01Z', cwd: gapRepo },
            { type: 'message', message: { role: 'user', content: `Read ${gapTask}/TASK.md` } },
          ]
            .map((row) => JSON.stringify(row))
            .join('\n') + '\n',
        );
      }
  }
  const staticFile = path.join(runs, 'static-run.json');
  const staticOriginal = JSON.stringify(staticReview, null, 2);
  await writeFile(staticFile, staticOriginal);
  const tmuxMarker = path.join(f, 'unexpected-tmux');
  await writeFile(path.join(cli, 'bin/tmux'), `#!/bin/sh\ntouch '${tmuxMarker}'\nexit 1\n`, {
    mode: 0o755,
  });
  const file = path.join(runs, 'run.json');
  const original = JSON.stringify(document, null, 2);
  await writeFile(file, original);
  const report = path.join(f, 'report.json');
  const env = {
    ...process.env,
    HOME: home,
    PATH: path.join(cli, 'bin') + path.delimiter + process.env.PATH,
    TSX_TSCONFIG_PATH: path.join(root, 'services/gateway/tsconfig.json'),
  };
  const run = (apply = false) =>
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        script,
        '--gateway-root',
        farm,
        '--runs-dir',
        runs,
        '--report',
        report,
        ...(apply ? ['--apply'] : []),
      ],
      { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const pid = path.join(farm, '.runs/gateway-1234.pid');
  await writeFile(pid, String(process.pid));
  run();
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(await readFile(staticFile, 'utf8'), staticOriginal);
  const gaps = JSON.parse(await readFile(report, 'utf8')).captureGaps;
  for (const kind of ['missing', 'ambiguous'])
    assert(
      gaps.some((gap) => gap.runId === kind && gap.role === 'review' && gap.sessionId === null),
    );
  assert.equal(JSON.parse(await readFile(report, 'utf8')).runsChanged, 2);
  assert.throws(() => run(true), /gateway pid.*running/);
  await rm(pid);
  run(true);
  const changed = JSON.parse(await readFile(file, 'utf8'));
  const staticChanged = JSON.parse(await readFile(staticFile, 'utf8'));
  assert.equal(staticChanged.agentContexts[0].runnerSessionId, 'static-session');
  assert.equal(staticChanged.sessionUsage[0].totalTokens, 60);
  assert.equal(staticChanged.sessionUsage[0].costUsd, 0.001);
  assert.equal(staticChanged.metrics.costEstimate, 0.001);
  assert.deepEqual(staticChanged.sessionUsage[0].roles, ['review']);
  assert.equal(staticChanged.metrics.runnerSessionId, 'static-session');
  assert.deepEqual(staticChanged.learning, staticReview.learning);
  assert.equal(staticChanged.status, 'failed');
  await assert.rejects(readFile(tmuxMarker), { code: 'ENOENT' });
  assert(
    (await readFile(sshMarker, 'utf8')).length > 0,
    'Offline discovery and capture use SSH without gateway RPC',
  );
  for (const { file, bytes } of gapDocuments) assert.equal(await readFile(file, 'utf8'), bytes);
  for (const context of changed.agentContexts.filter((row) => row.runnerSessionId))
    assert.equal(context.usage?.outputTokens, 20);
  assert.equal(
    changed.sessionUsage.find((row) => row.runnerSessionId === 'metric-only-conversation')
      .outputTokens,
    20,
    'Legacy metrics-only paths remain accounting sources',
  );
  assert.equal(changed.agentContexts.at(-1).usage.runnerSessionId, null);
  assert.equal(changed.agentContexts.at(-1).usage.costStatus, 'unpriced');
  assert.equal(changed.agentContexts[2].customContextField, 'preserve');
  assert.equal(changed.engineState.publishGate.reviews.length, 1);
  assert.equal(JSON.parse(await readFile(report, 'utf8')).unrepresented.length, 0);
  assert.equal(changed.agentContexts[0].usage.customReceiptNote, 'preserve receipt note');
  assert.equal(changed.agentContexts.at(-2).usage.customReceiptNote, 'separate context note');
  assert.ok(
    JSON.parse(await readFile(report, 'utf8')).captureGaps.some(
      (gap) => gap.sessionId === null && gap.role === 'write-task',
    ),
  );
  assert.deepEqual(changed.learning, document.learning);
  assert.deepEqual(changed.custom, document.custom);
  assert.equal(changed.steps[0].outputs.usage.source, 'runner-transcript');
  assert.equal(changed.steps[0].outputs.usage.outputTokens, 20);
  assert.equal(changed.steps[0].outputs.usage.retainedNote, 'keep this');
  assert.equal(changed.steps[0].outputs.usage.error, undefined);
  const applied = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(await readFile(applied.changes[0].backup, 'utf8'), original);
  const before = await readFile(file, 'utf8');
  const staticBefore = await readFile(staticFile, 'utf8');
  run(true);
  assert.equal(JSON.parse(await readFile(report, 'utf8')).runsChanged, 0);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(await readFile(staticFile, 'utf8'), staticBefore);
});
