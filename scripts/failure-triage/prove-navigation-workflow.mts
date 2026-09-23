/** Offline end-to-end proof of the navigation CLI. It never creates a provider client. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  advance,
  armOrder,
  nextPrompt,
  startSession,
  type Action,
  type NavigationCase,
  type TurnReceipt,
} from './workflow-navigation.mts';

const out = process.argv[2];
assert.ok(out, 'Provide a new proof directory');
await mkdir(out, { mode: 0o700 });
const file = (name: string) => path.join(out, name);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const run = (...args: string[]) => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/failure-triage/workflow-navigation-cli.mts', ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json' },
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
};
const reject = (...args: string[]) => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/failure-triage/workflow-navigation-cli.mts', ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json' },
      timeout: 30000,
    },
  );
  assert.notEqual(result.status, 0, 'Expected CLI rejection');
  assert.match(result.stderr, /worker journal/);
};

const cases: NavigationCase[] = [
  {
    id: 'fixture-case',
    failure: 'The worker exited before it recorded task activity.',
    sources: [
      { id: 'runner.stderr', title: 'Runner stderr', text: 'configured executable was absent' },
    ],
  },
];
const reference = {
  version: 1,
  status: 'frozen',
  references: [
    {
      caseId: 'fixture-case',
      label: 'environment',
      requiredReadIds: ['runner.stderr'],
      nextCheck: 'Inspect the configured worker executable.',
      family: 'runner-start',
    },
  ],
};
await writeFile(file('cases.json'), JSON.stringify(cases));
await writeFile(file('reference.json'), JSON.stringify(reference));
run('seal-advice', file('cases.json'), file('advice-plan.json'));
const advicePlan = JSON.parse(await readFile(file('advice-plan.json'), 'utf8'));
const advice = [
  {
    caseId: cases[0].id,
    text: 'Read runner.stderr first.',
    receipt: {
      responseId: 'advice-receipt',
      receiptHash: sha('advice-receipt'),
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerDurationMs: 2,
      elapsedMs: 3,
      costUsd: 0.0001,
    },
  },
];
const adviceRows = [
  {
    kind: 'approved',
    planHash: advicePlan.hash,
    configHash: sha('advice-config'),
    methodologyHash: sha('advice-method'),
    config: { provider: 'fixture', model: 'fixture-advice' },
  },
  { kind: 'started', caseId: cases[0].id },
  { kind: 'finished', ...advice[0] },
  { kind: 'closed', planHash: advicePlan.hash, stopReason: 'completed', attempts: 1 },
];
const adviceJournal = adviceRows.map((row) => JSON.stringify(row)).join('\n') + '\n';
await writeFile(file('advice-journal.jsonl'), adviceJournal);
await writeFile(
  file('advice.json'),
  JSON.stringify({
    stopReason: 'completed',
    advice,
    advicePlanHash: advicePlan.hash,
    configHash: sha('advice-config'),
    provider: 'fixture',
    model: 'fixture-advice',
    journalSha256: sha(adviceJournal),
  }),
);
run(
  'seal-worker',
  file('cases.json'),
  file('advice-plan.json'),
  file('advice.json'),
  file('advice-journal.jsonl'),
  file('reference.json'),
  file('worker-plan.json'),
);
const plan = JSON.parse(await readFile(file('worker-plan.json'), 'utf8'));
const config = { provider: 'fixture', model: 'fixture-worker' };
const method = 'Offline fixture method.';
await writeFile(file('method.md'), method);
const methodHash = sha(method);
let serial = 0;
const receipt = (): TurnReceipt => {
  const id = `worker-${++serial}`;
  return {
    responseId: id,
    receiptHash: sha(id),
    inputTokens: 16,
    outputTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerDurationMs: 2,
    elapsedMs: 3,
    costUsd: 0.00001,
  };
};
const sessions = [];
const journal: object[] = [
  {
    kind: 'approved',
    planHash: plan.hash,
    configHash: sha(JSON.stringify(config)),
    config,
    methodologyHash: methodHash,
  },
];
for (const arm of armOrder(0)) {
  let session = startSession(plan, cases[0].id, arm);
  for (const action of [
    { type: 'read_evidence', id: 'runner.stderr' },
    {
      type: 'answer',
      label: 'environment',
      nextCheck: 'Inspect the configured worker executable.',
      evidenceIds: ['runner.stderr'],
    },
  ] as Action[]) {
    const turn = session.turns.length + 1;
    const promptHash = sha(nextPrompt(plan, session));
    const turnReceipt = receipt();
    journal.push({ kind: 'started', caseId: session.caseId, arm, turn, promptHash });
    const advanced = advance(plan, session, action, turnReceipt);
    session = advanced.session;
    journal.push({
      kind: 'finished',
      caseId: session.caseId,
      arm,
      turn,
      promptHash,
      action,
      receipt: turnReceipt,
      status: session.status,
      ...(advanced.evidence ? { evidenceId: advanced.evidence.id } : {}),
    });
  }
  session = { ...session, wallElapsedMs: 9 };
  journal.push({
    kind: 'session-closed',
    caseId: session.caseId,
    arm,
    status: session.status,
    turnCount: session.turns.length,
    wallElapsedMs: session.wallElapsedMs,
  });
  sessions.push(session);
}
journal.push({ kind: 'closed', planHash: plan.hash, stopReason: 'completed', attempts: 4 });
const workerJournal = journal.map((row) => JSON.stringify(row)).join('\n') + '\n';
await writeFile(file('worker-journal.jsonl'), workerJournal);
const result = {
  sessions,
  stopReason: 'completed',
  planHash: plan.hash,
  configHash: sha(JSON.stringify(config)),
  provider: config.provider,
  model: config.model,
  methodologyHash: methodHash,
  journalSha256: sha(workerJournal),
};
await writeFile(file('sessions.json'), JSON.stringify(result));
run('blind', file('worker-plan.json'), file('sessions.json'), file('blind.json'));
const blind = JSON.parse(await readFile(file('blind.json'), 'utf8'));
await writeFile(
  file('judgment.json'),
  JSON.stringify({
    version: 1,
    packetHash: blind.hash,
    methodologyHash: methodHash,
    reviewer: 'fixture-reviewer',
    decisions: blind.rows.map((row: { blindId: string }) => ({
      blindId: row.blindId,
      decision: 'accepted',
      reason: 'Read source supports the answer.',
    })),
  }),
);
const tamperedJournal = workerJournal.replace('"promptHash":"', '"promptHash":"x');
await writeFile(file('tampered-worker-journal.jsonl'), tamperedJournal);
await writeFile(
  file('bad-sessions.json'),
  JSON.stringify({ ...result, journalSha256: sha(tamperedJournal) }),
);
reject(
  'score',
  file('worker-plan.json'),
  file('bad-sessions.json'),
  file('reference.json'),
  file('blind.json'),
  file('judgment.json'),
  file('method.md'),
  file('tampered-worker-journal.jsonl'),
  file('rejected-report.json'),
);
run(
  'score',
  file('worker-plan.json'),
  file('sessions.json'),
  file('reference.json'),
  file('blind.json'),
  file('judgment.json'),
  file('method.md'),
  file('worker-journal.jsonl'),
  file('report.json'),
);
const report = JSON.parse(await readFile(file('report.json'), 'utf8'));
assert.equal(report.decision, 'exploratory-complete');
assert.equal(report.completeMetricsPairs, 1);
assert.deepEqual(report.totals, {
  tokens: { baseline: 40, assisted: 55 },
  costUsd: { baseline: 0.00002, assisted: 0.00012 },
  elapsedMs: { baseline: 9, assisted: 12 },
});
console.log(
  JSON.stringify({ passed: true, completedScored: true, rejectionPath: true, providerCalls: 0 }),
);
