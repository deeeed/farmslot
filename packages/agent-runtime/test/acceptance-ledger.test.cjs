const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  AcceptanceRefusal,
  acceptanceContractIssues,
  acceptanceStatusList,
  renderAcceptanceCoverage,
  setDerivedClaims,
  summarizeAcceptanceStatus,
  validateAcceptanceStatusLedger,
  writeAcceptanceLedger,
} = require('../scripts/acceptance-ledger.cjs');
const { main: acceptanceCli } = require('../scripts/acceptance-cli.cjs');
const { engineClaims } = require('./acceptance-fixtures.cjs');
const { resolveWorkerTerminalContract } = require('../scripts/worker-terminal-contract.cjs');
const CRITERIA = [
  'The panel lists every criterion.',
  'A missing verdict blocks completion.',
  'Coverage comes from the engine.',
];
const checker = path.resolve(__dirname, '../scripts/check-task-artifact-contract.mjs');
const cli = path.resolve(__dirname, '../scripts/acceptance-cli.cjs');

function taskFixture(t, handoff = { task: { acceptanceCriteria: CRITERIA } }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acceptance-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'artifacts'));
  mkdirSync(path.join(dir, 'inputs'));
  writeFileSync(path.join(dir, 'inputs/handoff.json'), JSON.stringify(handoff));
  return dir;
}
function ac(dir, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--task-dir', dir], { encoding: 'utf8' });
}
function check(dir, ...args) {
  return spawnSync(process.execPath, [checker, dir, ...args], { encoding: 'utf8' });
}
function ledgerFile(dir) {
  return path.join(dir, 'artifacts/acceptance-status.json');
}

test('per-flow acceptance overrides inherit unspecified contract keys', () => {
  const base = {
    acceptance: { require: true, allowWeak: true },
    flows: { 'fix-bug': { acceptance: { require: false } } },
  };
  assert.deepEqual(resolveWorkerTerminalContract(base, 'fix-bug').acceptance, { allowWeak: true });
  assert.deepEqual(resolveWorkerTerminalContract(base, 'review-pr').acceptance, {
    require: true,
    allowWeak: true,
  });
  assert.deepEqual(
    resolveWorkerTerminalContract(
      {
        acceptance: { requireFresh: true },
        flows: { 'pr-complete': { acceptance: { requireFresh: false } } },
      },
      'pr-complete',
    ).acceptance,
    undefined,
  );
  assert.deepEqual(
    resolveWorkerTerminalContract({ acceptance: { requireFresh: true } }, 'pr-complete').acceptance,
    { requireFresh: true },
  );
});

test('PR completion keeps original criteria as evidence without requiring parent qualification', (t) => {
  const dir = taskFixture(t, {
    attemptId: 'child-run',
    flow: 'pr-complete',
    project: 'example',
    task: { acceptanceCriteria: CRITERIA },
  });
  const reference = {
    schemaVersion: 1,
    source: 'parent-run',
    childRunId: 'child-run',
    project: 'example',
    parentRunId: 'parent-run',
    headSha: 'a'.repeat(40),
    ledgerHash: 'b'.repeat(64),
    criteria: CRITERIA.map((text, index) => ({ id: `AC-${index + 1}`, text })),
  };
  const file = path.join(dir, 'inputs/inherited-acceptance.json');
  writeFileSync(file, JSON.stringify(reference));
  writeFileSync(path.join(dir, 'artifacts/comments-report.md'), 'Follow-up source work complete.');
  writeFileSync(path.join(dir, 'artifacts/learnings.md'), 'Retain original proof identity.');
  const contract = path.join(dir, 'inputs/worker-terminal-contract.json');
  writeFileSync(contract, JSON.stringify(resolveWorkerTerminalContract(null, 'pr-complete')));
  const completed = check(dir, '--contract', contract, '--terminal', 'complete');
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(existsSync(ledgerFile(dir)), false);
  assert.ok(acceptanceStatusList(dir).every(({ verdict }) => verdict === null));
  for (const patch of [
    { childRunId: 'foreign' },
    { project: 'foreign' },
    { ledgerHash: 'changed' },
    { criteria: reference.criteria.slice(1) },
    { childRunId: undefined },
  ]) {
    writeFileSync(file, JSON.stringify({ ...reference, ...patch }));
    assert.deepEqual(acceptanceContractIssues(dir), []);
  }
  writeFileSync(file, JSON.stringify(reference));
  writeFileSync(
    contract,
    JSON.stringify(
      resolveWorkerTerminalContract({ acceptance: { requireFresh: true } }, 'pr-complete'),
    ),
  );
  const fresh = check(dir, '--contract', contract, '--terminal', 'complete');
  assert.equal(fresh.status, 0, fresh.stderr);
});

test('read commands retain the registered order and unassessed rows', (t) => {
  const dir = taskFixture(t);
  assert.deepEqual(
    acceptanceStatusList(dir).map((row) => [row.id, row.verdict]),
    [
      ['AC-1', null],
      ['AC-2', null],
      ['AC-3', null],
    ],
  );
  assert.match(ac(dir, 'render').stderr, /no acceptance ledger yet.*recipe/);
  setDerivedClaims(dir, engineClaims(CRITERIA, ['proven', 'missing', 'untestable']));
  const result = ac(dir, 'list');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout).map((row) => row.verdict),
    ['proven', 'missing', 'untestable'],
  );
  assert.match(ac(dir, 'render').stdout, /Overall recipe coverage: 1\/3 ACs PROVEN/);
});

test('manual command refusal leaves no task ledger', (t) => {
  const dir = taskFixture(t);
  const result = ac(dir, 'set', 'AC-1', 'proven');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /engine-owned.*verified person/);
  assert.equal(existsSync(ledgerFile(dir)), false);
  assert.throws(
    () => acceptanceCli(['set', 'AC-1', 'untestable', '--task-dir', dir]),
    AcceptanceRefusal,
  );
});

test('read-command argument errors never write a ledger', (t) => {
  const dir = taskFixture(t);
  for (const [args, pattern] of [
    [['list', 'AC-1'], /takes no positional/],
    [['list', '--unexpected'], /unknown option/],
  ]) {
    const result = ac(dir, ...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, pattern);
  }
  assert.equal(existsSync(ledgerFile(dir)), false);
});

/**
 * One QA case execution and its retained package: rows it addresses carry a proof
 * node, the rest are missing, and every row cites the package trace.
 */
function caseClaims(dir, recipeRunId, addressed, caseDir = recipeRunId) {
  const root = `artifacts/recipe-runs/${caseDir}`;
  mkdirSync(path.join(dir, root), { recursive: true });
  writeFileSync(path.join(dir, root, 'trace.json'), '{}');
  const claims = engineClaims(CRITERIA);
  const ledger = {
    ...claims,
    recipeRunId,
    criteria: claims.criteria.map((row) => ({
      ...row,
      ...(row.id in addressed
        ? { verdict: addressed[row.id] }
        : { verdict: 'missing', recipeNodes: [], assertionIndices: [] }),
      evidence: [`${root}/trace.json`],
    })),
  };
  writeFileSync(path.join(dir, root, 'acceptance-status.json'), JSON.stringify(ledger));
  return ledger;
}
const rows = (dir) =>
  JSON.parse(readFileSync(ledgerFile(dir), 'utf8')).criteria.map((row) => [
    row.id,
    row.verdict,
    row.recipeRunId,
  ]);
const qaTask = (t) => taskFixture(t, { flow: 'qa', task: { acceptanceCriteria: CRITERIA } });

test('a QA task merges its case executions into one ledger keyed by criterion', (t) => {
  const dir = qaTask(t);
  const first = caseClaims(dir, 'qa-03', { 'AC-1': 'proven', 'AC-2': 'weak' });
  // Moments stay bound to the case execution that recorded them.
  first.criteria[0].moments = [
    { recipeRunId: 'qa-03', videoDigest: `sha256:${'a'.repeat(64)}`, traceIndex: 0 },
  ];
  setDerivedClaims(dir, first);
  setDerivedClaims(dir, caseClaims(dir, 'qa-08', { 'AC-3': 'proven' }));
  assert.equal(JSON.parse(readFileSync(ledgerFile(dir), 'utf8')).recipeRunId, 'qa-08');
  assert.deepEqual(rows(dir), [
    ['AC-1', 'proven', 'qa-03'],
    ['AC-2', 'weak', 'qa-03'],
    ['AC-3', 'proven', 'qa-08'],
  ]);
  // A case that addresses none of them keeps every row; a rerun replaces only what it addresses.
  setDerivedClaims(dir, caseClaims(dir, 'qa-11', {}));
  setDerivedClaims(dir, caseClaims(dir, 'qa-03-rerun', { 'AC-2': 'proven' }));
  assert.deepEqual(rows(dir), [
    ['AC-1', 'proven', 'qa-03'],
    ['AC-2', 'proven', 'qa-03-rerun'],
    ['AC-3', 'proven', 'qa-08'],
  ]);
  assert.deepEqual(acceptanceContractIssues(dir), []);
  // A later missing verdict replaces earlier proof of the criterion it addresses.
  setDerivedClaims(dir, caseClaims(dir, 'qa-08-rerun', { 'AC-3': 'missing' }));
  assert.deepEqual(rows(dir)[2], ['AC-3', 'missing', 'qa-08-rerun']);
  assert.match(acceptanceContractIssues(dir).join('\n'), /AC-3 is missing/);
});

test('a QA merge keeps no row whose package is gone or holds another execution', (t) => {
  const dir = qaTask(t);
  setDerivedClaims(dir, caseClaims(dir, 'qa-03', { 'AC-1': 'proven' }));
  rmSync(path.join(dir, 'artifacts/recipe-runs/qa-03/trace.json'));
  setDerivedClaims(dir, caseClaims(dir, 'qa-08', { 'AC-2': 'proven' }));
  assert.deepEqual(rows(dir).slice(0, 2), [
    ['AC-1', 'missing', 'qa-08'],
    ['AC-2', 'proven', 'qa-08'],
  ]);
  // A rerun into the same case directory replaces the execution its old rows named.
  setDerivedClaims(dir, caseClaims(dir, 'qa-11', { 'AC-3': 'proven' }, 'QA-11'));
  setDerivedClaims(dir, caseClaims(dir, 'qa-11-rerun', {}, 'QA-11'));
  assert.deepEqual(rows(dir)[2], ['AC-3', 'missing', 'qa-11-rerun']);
  writeFileSync(ledgerFile(dir), '{');
  setDerivedClaims(dir, caseClaims(dir, 'qa-12', { 'AC-3': 'proven' }));
  assert.deepEqual(rows(dir), [
    ['AC-1', 'missing', 'qa-12'],
    ['AC-2', 'missing', 'qa-12'],
    ['AC-3', 'proven', 'qa-12'],
  ]);
});

test('other flows keep only the selected execution', (t) => {
  const dir = taskFixture(t, { flow: 'fix-bug', task: { acceptanceCriteria: CRITERIA } });
  setDerivedClaims(dir, caseClaims(dir, 'first', { 'AC-1': 'proven' }));
  setDerivedClaims(dir, caseClaims(dir, 'second', { 'AC-2': 'proven' }));
  assert.deepEqual(rows(dir), [
    ['AC-1', 'missing', undefined],
    ['AC-2', 'proven', undefined],
    ['AC-3', 'missing', undefined],
  ]);
  const ledger = JSON.parse(readFileSync(ledgerFile(dir), 'utf8'));
  ledger.criteria[0].recipeRunId = '';
  assert.match(validateAcceptanceStatusLedger(ledger).join('\n'), /recipeRunId: expected/);
});

test('engine transfer refuses unregistered ids, changed text and invalid evidence paths', (t) => {
  const dir = taskFixture(t);
  const claims = engineClaims(CRITERIA);
  setDerivedClaims(dir, claims);
  const before = readFileSync(ledgerFile(dir));
  for (const [mutate, pattern] of [
    [
      (c) => {
        c.criteria[0].text = 'Changed registration';
      },
      /does not match/,
    ],
    [
      (c) => {
        c.criteria.push({ ...c.criteria[0], id: 'AC-9' });
      },
      /Unknown task claim AC-9/,
    ],
    [
      (c) => {
        c.criteria[0].evidence = ['../outside'];
      },
      /stay inside/,
    ],
    [
      (c) => {
        c.criteria[0].evidence = ['/outside'];
      },
      /relative/,
    ],
    [
      (c) => {
        c.criteria[0].evidence = ['artifacts/missing.txt'];
      },
      /does not exist/,
    ],
  ]) {
    const candidate = structuredClone(claims);
    mutate(candidate);
    assert.throws(() => setDerivedClaims(dir, candidate), pattern);
    assert.deepEqual(readFileSync(ledgerFile(dir)), before);
  }
});

test('the schema-2 writer refuses malformed verdict and moment fields', (t) => {
  const dir = taskFixture(t);
  const claims = engineClaims(CRITERIA);
  claims.criteria[0].verdict = 'nope';
  delete claims.criteria[1].moments;
  assert.throws(
    () => writeAcceptanceLedger(dir, claims),
    (error) =>
      error instanceof AcceptanceRefusal &&
      /verdict/.test(error.message) &&
      /moments/.test(error.message),
  );
  assert.equal(existsSync(ledgerFile(dir)), false);
  assert.ok(
    validateAcceptanceStatusLedger({ schemaVersion: 2, criteria: [] }).some((issue) =>
      /recipeRunId/.test(issue),
    ),
  );
});

test('summary counts every registered row and rendering escapes criterion text', () => {
  const claims = engineClaims(
    ['Line one\nwith | pipe', ...CRITERIA.slice(1)],
    ['proven', 'weak', 'untestable'],
  );
  const registered = [
    ...claims.criteria.map(({ id, text }) => ({ id, text })),
    { id: 'AC-4', text: 'Not assessed' },
  ];
  const summary = summarizeAcceptanceStatus(claims, registered);
  assert.equal(summary.total, 4);
  assert.equal(summary.proven, 1);
  assert.equal(summary.weak, 1);
  assert.equal(summary.untestable, 1);
  assert.equal(summary.unrecorded, 1);
  const rendered = renderAcceptanceCoverage(claims, registered);
  assert.match(rendered, /Line one.*pipe/);
  assert.match(rendered, /AC-4/);
  assert.match(rendered, /Overall recipe coverage: 1\/4 ACs PROVEN/);
});

test('successful completion requires current claims and no-change keeps its outcome contract', (t) => {
  const dir = taskFixture(t);
  assert.equal(check(dir, '--terminal', 'complete').status, 1);
  assert.match(check(dir, '--require-acceptance-status').stderr, /is missing.*recipe/);
  assert.equal(check(dir, '--terminal', 'no-change').status, 0);
  setDerivedClaims(dir, engineClaims(CRITERIA));
  const result = check(dir, '--require-acceptance-status');
  assert.equal(result.status, 0, result.stderr);
});

test('weak waivers do not admit missing registration or legacy schema', (t) => {
  const dir = taskFixture(t);
  const weak = engineClaims(CRITERIA, ['weak', 'missing', 'proven']);
  setDerivedClaims(dir, weak);
  assert.ok(acceptanceContractIssues(dir).some((issue) => /AC-1 is weak/.test(issue)));
  assert.deepEqual(acceptanceContractIssues(dir, { allowWeak: true }), []);
  writeAcceptanceLedger(dir, { ...weak, criteria: weak.criteria.slice(0, 1) });
  assert.ok(
    acceptanceContractIssues(dir, { allowWeak: true }).some((issue) =>
      /AC-2 has no engine verdict/.test(issue),
    ),
  );
  writeFileSync(
    ledgerFile(dir),
    JSON.stringify({
      schemaVersion: 1,
      criteria: CRITERIA.map((text, index) => ({
        id: `AC-${index + 1}`,
        text,
        verdict: 'proven',
        evidence: [],
        recipeNodes: [],
        updatedAt: '2026-10-12T00:00:00Z',
      })),
    }),
  );
  assert.ok(
    acceptanceContractIssues(dir, { allowWeak: true, deferClaimVerdicts: true }).some((issue) =>
      /display only/.test(issue),
    ),
  );
  assert.match(ac(dir, 'render').stdout, /Legacy schema-1 ledger: retained display only/);
});

test('unreadable handoffs and ledgers fail completion with their original cause', (t) => {
  for (const body of ['{not JSON', JSON.stringify({ task: { acceptanceCriteria: 'one' } })]) {
    const dir = taskFixture(t);
    writeFileSync(path.join(dir, 'inputs/handoff.json'), body);
    assert.ok(acceptanceContractIssues(dir).some((issue) => /invalid inputs/.test(issue)));
  }
  const dir = taskFixture(t);
  writeFileSync(ledgerFile(dir), '{not JSON');
  assert.ok(acceptanceContractIssues(dir).some((issue) => /invalid JSON/.test(issue)));
  const none = taskFixture(t, { task: { title: 'No registered criteria' } });
  assert.deepEqual(acceptanceContractIssues(none), []);
});

test('PR completion never blocks on unbound original visual evidence', (t) => {
  const dir = taskFixture(t, { flow: 'pr-complete', task: { acceptanceCriteria: CRITERIA } });
  assert.deepEqual(acceptanceContractIssues(dir), []);
  const ledger = engineClaims(CRITERIA, ['missing', 'awaiting-review', 'failed']);
  ledger.criteria.forEach((row) => {
    row.proofMode = 'visual';
  });
  writeFileSync(ledgerFile(dir), JSON.stringify(ledger));
  assert.deepEqual(acceptanceContractIssues(dir), []);
  assert.deepEqual(
    acceptanceStatusList(dir).map(({ verdict }) => verdict),
    ['missing', 'awaiting-review', 'failed'],
  );
});

test('PR completion still requires worker proof for derived requirements without waiting on reviewers', (t) => {
  const dir = taskFixture(t, {
    attemptId: 'completion',
    flow: 'pr-complete',
    task: { acceptanceCriteria: ['Original visual AC'] },
  });
  writeFileSync(
    path.join(dir, 'inputs/acceptance-registration.json'),
    JSON.stringify({
      schemaVersion: 1,
      generation: 0,
      registration: {
        schemaVersion: 1,
        runId: 'completion',
        revision: 1,
        original: [{ id: 'AC-1', text: 'Original visual AC' }],
        derived: [
          {
            id: 'AC-2',
            text: 'Fix the reported finding',
            proofMode: 'state',
            source: {
              kind: 'review-comment',
              sourceId: 'comment:1',
              sourceVersion: '1',
              obligationIndex: 0,
            },
          },
        ],
        units: [],
      },
    }),
  );
  assert.match(acceptanceContractIssues(dir).join(';'), /acceptance-status.json is missing/);
  const ledger = engineClaims(
    ['Original visual AC', 'Fix the reported finding'],
    ['missing', 'failed'],
  );
  writeFileSync(ledgerFile(dir), JSON.stringify(ledger));
  assert.match(acceptanceContractIssues(dir).join(';'), /AC-2 is failed/);
  assert.match(
    acceptanceContractIssues(dir, { deferClaimVerdicts: true }).join(';'),
    /AC-2 is failed/,
  );
  ledger.criteria[1].verdict = 'proven';
  writeFileSync(ledgerFile(dir), JSON.stringify(ledger));
  assert.deepEqual(acceptanceContractIssues(dir), []);
  for (const mode of ['visual', 'mixed', 'review']) {
    const projection = JSON.parse(
      readFileSync(path.join(dir, 'inputs/acceptance-registration.json'), 'utf8'),
    );
    projection.registration.derived[0].proofMode = mode;
    writeFileSync(
      path.join(dir, 'inputs/acceptance-registration.json'),
      JSON.stringify(projection),
    );
    ledger.criteria[1].proofMode = mode;
    ledger.criteria[1].verdict = 'awaiting-review';
    writeFileSync(ledgerFile(dir), JSON.stringify(ledger));
    assert.deepEqual(acceptanceContractIssues(dir), [], mode);
  }
});
