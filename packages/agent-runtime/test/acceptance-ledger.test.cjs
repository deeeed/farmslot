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
