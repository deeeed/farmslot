/** Offline end-to-end proof of the navigation CLI. It never creates a provider client. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
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
assert.deepEqual(armOrder(0), ['baseline', 'assisted']);
assert.deepEqual(armOrder(1), ['assisted', 'baseline']);
function cli(ok: boolean, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/failure-triage/workflow-navigation-cli.mts', ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json' },
      timeout: 30000,
    },
  );
  if (ok) assert.equal(result.status, 0, result.stderr);
  else {
    assert.notEqual(result.status, 0, 'Expected CLI rejection');
    assert.match(result.stderr, /worker journal/);
  }
}
const cases: NavigationCase[] = ['one', 'two'].map((id) => ({
  id: `fixture-${id}`,
  failure: `The ${id} worker exited before it recorded task activity.`,
  sources: [
    { id: 'runner.stderr', title: 'Runner stderr', text: 'configured executable was absent' },
  ],
}));
const reference = {
  version: 1,
  status: 'frozen',
  references: cases.map((item) => ({
    caseId: item.id,
    label: 'environment',
    requiredReadIds: ['runner.stderr'],
    nextCheck: 'Inspect the configured worker executable.',
    family: 'runner-start',
  })),
};
await writeFile(file('cases.json'), JSON.stringify(cases));
await writeFile(file('reference.json'), JSON.stringify(reference));
cli(true, 'seal-advice', file('cases.json'), file('advice-plan.json'));
const advicePlan = JSON.parse(await readFile(file('advice-plan.json'), 'utf8'));
const advice = cases.map((item, index) => ({
  caseId: item.id,
  text: 'Read runner.stderr first.',
  receipt: {
    responseId: `advice-${index}`,
    receiptHash: sha(`advice-${index}`),
    inputTokens: 12,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerDurationMs: 2,
    elapsedMs: 3,
    costUsd: 0.0001,
  },
}));
const adviceRows = [
  {
    kind: 'approved',
    planHash: advicePlan.hash,
    configHash: sha('advice-config'),
    methodologyHash: sha('advice-method'),
    config: { provider: 'fixture', model: 'fixture-advice' },
  },
  ...cases.flatMap((item, index) => [
    { kind: 'started', caseId: item.id },
    { kind: 'finished', ...advice[index] },
  ]),
  { kind: 'closed', planHash: advicePlan.hash, stopReason: 'completed', attempts: cases.length },
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
cli(
  true,
  'seal-worker',
  file('cases.json'),
  file('advice-plan.json'),
  file('advice.json'),
  file('advice-journal.jsonl'),
  file('reference.json'),
  file('worker-plan.json'),
);
const plan = JSON.parse(await readFile(file('worker-plan.json'), 'utf8'));
const config = { provider: 'fixture', model: 'fixture-worker' },
  method = 'Offline fixture method.',
  methodHash = sha(method);
await writeFile(file('method.md'), method);
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
const sessions = [],
  journal: object[] = [
    {
      kind: 'approved',
      planHash: plan.hash,
      configHash: sha(JSON.stringify(config)),
      config,
      methodologyHash: methodHash,
    },
  ];
for (const [index, item] of cases.entries())
  for (const arm of armOrder(index)) {
    let session = startSession(plan, item.id, arm);
    for (const action of [
      { type: 'read_evidence', id: 'runner.stderr' },
      {
        type: 'answer',
        label: 'environment',
        nextCheck: 'Inspect the configured worker executable.',
        evidenceIds: ['runner.stderr'],
      },
    ] as Action[]) {
      const turn = session.turns.length + 1,
        promptHash = sha(nextPrompt(plan, session)),
        turnReceipt = receipt();
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
journal.push({ kind: 'closed', planHash: plan.hash, stopReason: 'completed', attempts: 8 });
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
cli(true, 'blind', file('worker-plan.json'), file('sessions.json'), file('blind.json'));
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
const tamperedJournal = workerJournal.replace(
  '"action":{"type":"read_evidence"',
  '"action":{"type":"answer"',
);
await writeFile(file('tampered-worker-journal.jsonl'), tamperedJournal);
await writeFile(
  file('tampered-sessions.json'),
  JSON.stringify({ ...result, journalSha256: sha(tamperedJournal) }),
);
cli(
  false,
  'score',
  file('worker-plan.json'),
  file('tampered-sessions.json'),
  file('reference.json'),
  file('blind.json'),
  file('judgment.json'),
  file('method.md'),
  file('tampered-worker-journal.jsonl'),
  file('rejected-report.json'),
);
await assert.rejects(access(file('rejected-report.json')));
// A session receipt must agree with the journal before its costs enter the score.
const changedReceipt = structuredClone(result);
changedReceipt.sessions[0].turns[0].receipt.costUsd = 0;
await writeFile(file('changed-receipt-sessions.json'), JSON.stringify(changedReceipt));
cli(
  false,
  'score',
  file('worker-plan.json'),
  file('changed-receipt-sessions.json'),
  file('reference.json'),
  file('blind.json'),
  file('judgment.json'),
  file('method.md'),
  file('worker-journal.jsonl'),
  file('changed-receipt-report.json'),
);
await assert.rejects(access(file('changed-receipt-report.json')));
async function rejectChangedJournal(name: string, rows: object[]) {
  const changedJournal = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(file(`${name}-journal.jsonl`), changedJournal);
  await writeFile(
    file(`${name}-sessions.json`),
    JSON.stringify({ ...result, journalSha256: sha(changedJournal) }),
  );
  cli(
    false,
    'score',
    file('worker-plan.json'),
    file(`${name}-sessions.json`),
    file('reference.json'),
    file('blind.json'),
    file('judgment.json'),
    file('method.md'),
    file(`${name}-journal.jsonl`),
    file(`${name}-report.json`),
  );
  await assert.rejects(access(file(`${name}-report.json`)));
}
const wrongPrompt = sha('wrong prompt');
await rejectChangedJournal(
  'wrong-prompt',
  journal.map((row, index) =>
    index === 1 || index === 2 ? { ...row, promptHash: wrongPrompt } : row,
  ),
);
await rejectChangedJournal(
  'wrong-status',
  journal.map((row, index) => (index === 2 ? { ...row, status: 'answered' } : row)),
);
const swapped = [...sessions];
[swapped[2], swapped[3]] = [swapped[3], swapped[2]];
// Pair two has five journal rows per arm. Reorder those rows as well, so only
// the alternating arm-order guard can reject this otherwise consistent study.
const swappedRows = [...journal];
swappedRows.splice(11, 10, ...journal.slice(16, 21), ...journal.slice(11, 16));
const swappedJournal = swappedRows.map((row) => JSON.stringify(row)).join('\n') + '\n';
await writeFile(file('swapped-worker-journal.jsonl'), swappedJournal);
await writeFile(
  file('swapped-sessions.json'),
  JSON.stringify({ ...result, sessions: swapped, journalSha256: sha(swappedJournal) }),
);
cli(
  false,
  'score',
  file('worker-plan.json'),
  file('swapped-sessions.json'),
  file('reference.json'),
  file('blind.json'),
  file('judgment.json'),
  file('method.md'),
  file('swapped-worker-journal.jsonl'),
  file('swapped-report.json'),
);
await assert.rejects(access(file('swapped-report.json')));
cli(
  true,
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
assert.equal(report.completeMetricsPairs, 2);
assert.deepEqual(report.totals, {
  tokens: { baseline: 80, assisted: 110 },
  costUsd: { baseline: 0.00004, assisted: 0.00024 },
  elapsedMs: { baseline: 18, assisted: 24 },
});
console.log(
  JSON.stringify({ passed: true, completedScored: true, rejectionPath: true, providerCalls: 0 }),
);
