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
  assert.equal(JSON.parse(await readFile(report, 'utf8')).runsChanged, 1);
  assert.throws(() => run(true), /gateway pid.*running/);
  await rm(pid);
  run(true);
  const changed = JSON.parse(await readFile(file, 'utf8'));
  for (const context of changed.agentContexts.filter((row) => row.runnerSessionId))
    assert.equal(context.usage?.outputTokens, 20);
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
  run(true);
  assert.equal(JSON.parse(await readFile(report, 'utf8')).runsChanged, 0);
  assert.equal(await readFile(file, 'utf8'), before);
});
