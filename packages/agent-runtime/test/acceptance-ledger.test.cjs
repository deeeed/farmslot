#!/usr/bin/env node
// `farmslot-agent ac` — the acceptance-criteria ledger (ADR-060).
//
// Every refusal the CLI owes the worker is asserted here, plus the summary math
// and the `--require-acceptance-status` terminal gate. The ledger is written only
// through the CLI: no test hand-writes artifacts/acceptance-status.json except
// where the point is that a hand-edited file is refused.
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts', 'acceptance-cli.cjs');
const checker = path.join(root, 'scripts', 'check-task-artifact-contract.mjs');
const {
  AcceptanceRefusal,
  renderAcceptanceCoverage,
  summarizeAcceptanceStatus,
  validateAcceptanceStatusLedger,
  writeAcceptanceLedger,
} = require('../scripts/acceptance-ledger.cjs');
const { resolveWorkerTerminalContract } = require('../scripts/worker-terminal-contract.cjs');

const scopedAcceptance = {
  acceptance: { require: false },
  flows: { 'fix-bug': { acceptance: { require: true } } },
};
assert.deepEqual(resolveWorkerTerminalContract(scopedAcceptance, 'fix-bug').acceptance, {
  require: true,
});
assert.equal(resolveWorkerTerminalContract(scopedAcceptance, 'review-pr').acceptance, undefined);
assert.deepEqual(
  resolveWorkerTerminalContract(
    {
      acceptance: { require: true, allowWeak: true },
      flows: { 'fix-bug': { acceptance: { require: false } } },
    },
    'fix-bug',
  ).acceptance,
  { allowWeak: true },
);
assert.deepEqual(
  resolveWorkerTerminalContract(
    { acceptance: { require: true, allowWeak: true }, flows: { 'fix-bug': { acceptance: {} } } },
    'fix-bug',
  ).acceptance,
  { require: true, allowWeak: true },
);

const CRITERIA = [
  'The run detail panel lists every acceptance criterion with its verdict.',
  'A weak verdict blocks the terminal mark.',
  'The coverage table renders from the ledger.',
];

function makeTask({ criteria = CRITERIA, contract } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-ac-'));
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  writeFileSync(
    path.join(dir, 'inputs', 'handoff.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        attemptId: 'ac-attempt',
        surface: 'test',
        project: 'demo',
        domain: '',
        flow: 'dev',
        task: {
          title: 'Acceptance ledger',
          sourceKind: 'text',
          ...(criteria.length > 0 ? { acceptanceCriteria: criteria } : {}),
        },
        taskDocument: 'TASK.md',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(dir, 'artifacts', 'after-panel.png'), 'png');
  writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- Ledger first.\n');
  if (contract) {
    writeFileSync(
      path.join(dir, 'inputs', 'worker-terminal-contract.json'),
      `${JSON.stringify(contract, null, 2)}\n`,
    );
  }
  return dir;
}

// --task-dir goes right after the command, so a trailing flag in a test stays
// dangling instead of swallowing it.
function ac(dir, command, ...args) {
  return spawnSync(process.execPath, [cli, command, '--task-dir', dir, ...args], {
    encoding: 'utf8',
  });
}

function ledgerOf(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'artifacts', 'acceptance-status.json'), 'utf8'));
}

function refused(result, pattern, label) {
  assert.notEqual(result.status, 0, `${label} must be refused:\n${result.stdout}`);
  assert.match(`${result.stderr}${result.stdout}`, pattern, label);
}

// ---------------------------------------------------------------------------
// 1. Ids come from the handoff; nothing is recorded until `ac set` runs.
{
  const dir = makeTask();
  const listed = ac(dir, 'list');
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['AC-1', 'AC-2', 'AC-3'],
  );
  assert.deepEqual(
    rows.map((row) => row.verdict),
    [null, null, null],
  );
  assert.equal(rows[0].text, CRITERIA[0], 'list carries the criterion text from the handoff');
  refused(ac(dir, 'render'), /no acceptance ledger yet/, 'render before any verdict');
}

// ---------------------------------------------------------------------------
// 2. Refusals: unknown id, unknown verdict, unknown proof mode, bad evidence.
{
  const dir = makeTask();
  refused(
    ac(dir, 'set', 'AC-9', 'proven'),
    /unknown acceptance criterion AC-9; inputs\/handoff\.json lists AC-1, AC-2, AC-3/,
    'a criterion the handoff does not list',
  );
  refused(ac(dir, 'set', 'AC1', 'proven'), /unknown acceptance criterion AC1/, 'a malformed id');
  refused(
    ac(dir, 'set', 'AC-1', 'looks-fine'),
    /unknown verdict looks-fine; expected one of proven, weak, missing, untestable/,
    'a verdict outside the vocabulary',
  );
  refused(
    ac(dir, 'set', 'AC-1', 'proven', '--proof-mode', 'vibes'),
    /unknown proof mode vibes; expected one of state, visual, mixed/,
    'a proof mode outside the vocabulary',
  );
  refused(
    ac(dir, 'set', 'AC-1', 'proven', '--evidence', 'artifacts/never-written.png'),
    /evidence path does not exist: artifacts\/never-written\.png/,
    'evidence that does not exist',
  );
  refused(
    ac(dir, 'set', 'AC-1', 'proven', '--evidence', '../outside.png'),
    /evidence path must stay inside the task dir/,
    'evidence outside the task dir',
  );
  refused(
    ac(dir, 'set', 'AC-1', 'proven', '--evidence', '/etc/hosts'),
    /evidence path must be relative to the task dir/,
    'an absolute evidence path',
  );
  refused(ac(dir, 'set', 'AC-1'), /usage: ac set/, 'set without a verdict');
  refused(
    ac(dir, 'set', 'AC-1', 'proven', '--evidence'),
    /--evidence requires a value/,
    'a dangling flag',
  );
  refused(
    ac(dir, 'list', 'AC-1'),
    /ac list takes no positional arguments/,
    'list with a positional',
  );
  assert.equal(
    ac(dir, 'list').stdout.includes('"verdict": null'),
    true,
    'no refusal left a verdict behind',
  );
}

// ---------------------------------------------------------------------------
// 3. A recorded verdict: handoff order, evidence, file mode, idempotent re-set.
{
  const dir = makeTask();
  assert.equal(ac(dir, 'set', 'AC-3', 'proven', '--proof-mode', 'state').status, 0);
  const set = ac(
    dir,
    'set',
    'AC-1',
    'proven',
    '--proof-mode',
    'visual',
    '--evidence',
    'artifacts/after-panel.png',
    '--recipe-node',
    'assert-panel',
    '--recipe-node',
    'screenshot-panel',
  );
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /^AC-1: proven \(visual\)$/m);
  let ledger = ledgerOf(dir);
  assert.equal(ledger.schemaVersion, 1);
  assert.deepEqual(
    ledger.criteria.map((entry) => entry.id),
    ['AC-1', 'AC-3'],
    'the ledger keeps handoff order, not write order',
  );
  const first = ledger.criteria[0];
  assert.equal(first.text, CRITERIA[0]);
  assert.deepEqual(first.evidence, ['artifacts/after-panel.png']);
  assert.deepEqual(first.recipeNodes, ['assert-panel', 'screenshot-panel']);
  assert.ok(Date.parse(first.updatedAt) > 0, 'updatedAt is a timestamp');
  assert.deepEqual(validateAcceptanceStatusLedger(ledger), []);
  const mode = statSync(path.join(dir, 'artifacts', 'acceptance-status.json')).mode & 0o777;
  assert.equal(mode, 0o644, 'the ledger carries the artifact file mode');
  assert.ok(
    readFileSync(path.join(dir, 'artifacts', 'acceptance-status.json'), 'utf8').endsWith('}\n'),
    'the ledger ends with a newline',
  );

  // A second verdict for the same id replaces it rather than appending.
  assert.equal(
    ac(dir, 'set', 'AC-1', 'untestable', '--note', 'No client reaches it yet.').status,
    0,
  );
  ledger = ledgerOf(dir);
  assert.equal(ledger.criteria.filter((entry) => entry.id === 'AC-1').length, 1);
  assert.equal(ledger.criteria[0].verdict, 'untestable');
  assert.equal(ledger.criteria[0].note, 'No client reaches it yet.');
  assert.deepEqual(ledger.criteria[0].evidence, [], 're-setting clears the previous evidence');
  assert.equal(ledger.criteria[0].proofMode, undefined);
}

// ---------------------------------------------------------------------------
// 4. A hand-edited ledger is refused instead of silently rewritten.
{
  const dir = makeTask();
  assert.equal(ac(dir, 'set', 'AC-1', 'proven').status, 0);
  const file = path.join(dir, 'artifacts', 'acceptance-status.json');
  writeFileSync(file, '{ not json');
  refused(ac(dir, 'set', 'AC-2', 'proven'), /invalid JSON/, 'a ledger that is not JSON');
  writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 1, criteria: [{ id: 'AC-1', text: 'x', verdict: 'nope' }] })}\n`,
  );
  refused(
    ac(dir, 'set', 'AC-2', 'proven'),
    /does not match the ledger contract[\s\S]*criteria\[0\]\.verdict/,
    'a ledger entry with an invalid verdict',
  );
}

// ---------------------------------------------------------------------------
// 5. A task without criteria has no ledger, and a non-task dir says so.
{
  const dir = makeTask({ criteria: [] });
  refused(
    ac(dir, 'set', 'AC-1', 'proven'),
    /inputs\/handoff\.json lists no acceptance criteria/,
    'set on a task with no criteria',
  );
  assert.equal(JSON.parse(ac(dir, 'list').stdout).length, 0);
  const bare = mkdtempSync(path.join(tmpdir(), 'farmslot-ac-bare-'));
  refused(
    ac(bare, 'list'),
    /is not a task directory \(no inputs\/handoff\.json\); pass --task-dir/,
    'a directory that is not a task dir',
  );
}

// ---------------------------------------------------------------------------
// 6. Summary math and the rendered coverage table.
{
  const dir = makeTask();
  assert.equal(
    ac(
      dir,
      'set',
      'AC-1',
      'proven',
      '--proof-mode',
      'visual',
      '--evidence',
      'artifacts/after-panel.png',
      '--recipe-node',
      'assert-panel',
    ).status,
    0,
  );
  assert.equal(ac(dir, 'set', 'AC-2', 'weak', '--note', 'Unit test only | not wired').status, 0);
  assert.equal(ac(dir, 'set', 'AC-3', 'untestable', '--note', 'No endpoint yet.').status, 0);
  const ledger = ledgerOf(dir);
  assert.deepEqual(summarizeAcceptanceStatus(ledger), {
    proven: 1,
    weak: 1,
    missing: 0,
    untestable: 1,
    unrecorded: 0,
    total: 3,
  });
  // Given the registered criteria, an unjudged one is counted rather than ignored.
  assert.deepEqual(
    summarizeAcceptanceStatus(ledger, [
      { id: 'AC-1', text: CRITERIA[0] },
      { id: 'AC-2', text: CRITERIA[1] },
      { id: 'AC-3', text: CRITERIA[2] },
      { id: 'AC-4', text: 'Not judged yet' },
    ]),
    { proven: 1, weak: 1, missing: 0, untestable: 1, unrecorded: 1, total: 4 },
  );
  const rendered = ac(dir, 'render');
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout, renderAcceptanceCoverage(ledger));
  const lines = rendered.stdout.trimEnd().split('\n');
  assert.equal(
    lines[lines.length - 1],
    'Overall recipe coverage: 1/3 ACs PROVEN (untestable: AC-3, weak: 1, missing: 0)',
  );
  assert.match(
    rendered.stdout,
    /\| AC-1 \|.*\| PROVEN \| visual \| assert-panel \| artifacts\/after-panel\.png \|/,
  );
  assert.match(rendered.stdout, /Unit test only \\\| not wired/, 'a pipe in a note is escaped');
  assert.match(rendered.stdout, /\| AC-3 \|.*\| UNTESTABLE \| - \| - \| - \| No endpoint yet\. \|/);

  // Every criterion proven: the untestable list reads "none".
  assert.equal(ac(dir, 'set', 'AC-2', 'proven', '--proof-mode', 'state').status, 0);
  assert.equal(ac(dir, 'set', 'AC-3', 'proven', '--proof-mode', 'mixed').status, 0);
  const full = ac(dir, 'render').stdout.trimEnd().split('\n');
  assert.equal(
    full[full.length - 1],
    'Overall recipe coverage: 3/3 ACs PROVEN (untestable: none, weak: 0, missing: 0)',
  );
}

// ---------------------------------------------------------------------------
// 7. Ledger validation rejects every malformed shape on its own.
{
  assert.deepEqual(validateAcceptanceStatusLedger(null), ['acceptance ledger: expected object']);
  assert.deepEqual(validateAcceptanceStatusLedger([]), ['acceptance ledger: expected object']);
  assert.match(
    validateAcceptanceStatusLedger({ schemaVersion: 2, criteria: [] }).join('\n'),
    /schemaVersion: expected 1/,
  );
  assert.match(
    validateAcceptanceStatusLedger({ schemaVersion: 1, criteria: {} }).join('\n'),
    /criteria: expected array/,
  );
  const entry = {
    id: 'AC-1',
    text: 'x',
    verdict: 'proven',
    evidence: [],
    recipeNodes: [],
    updatedAt: '2026-09-19T10:00:00.000Z',
  };
  assert.deepEqual(validateAcceptanceStatusLedger({ schemaVersion: 1, criteria: [entry] }), []);
  assert.match(
    validateAcceptanceStatusLedger({ schemaVersion: 1, criteria: [entry, entry] }).join('\n'),
    /criteria\[1\]\.id: duplicate AC-1/,
  );
  assert.match(
    validateAcceptanceStatusLedger({
      schemaVersion: 1,
      criteria: [{ ...entry, evidence: [''] }],
    }).join('\n'),
    /criteria\[0\]\.evidence: expected an array of non-empty strings/,
  );
  assert.match(
    validateAcceptanceStatusLedger({
      schemaVersion: 1,
      criteria: [{ ...entry, updatedAt: '' }],
    }).join('\n'),
    /criteria\[0\]\.updatedAt: expected non-empty string/,
  );
  assert.match(
    validateAcceptanceStatusLedger({
      schemaVersion: 1,
      criteria: [{ ...entry, proofMode: 'guesswork' }],
    }).join('\n'),
    /criteria\[0\]\.proofMode: expected one of state, visual, mixed/,
  );
}

// ---------------------------------------------------------------------------
// 8. The terminal gate: --require-acceptance-status.
function check(dir, ...args) {
  return spawnSync(process.execPath, [checker, dir, ...args], { encoding: 'utf8' });
}

{
  // No criteria: the flag is a no-op.
  const bare = makeTask({ criteria: [] });
  assert.equal(check(bare, '--require-acceptance-status').status, 0);

  // Criteria but no ledger.
  const dir = makeTask();
  let result = check(dir, '--require-acceptance-status');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /artifacts\/acceptance-status\.json is missing but inputs\/handoff\.json lists 3/,
  );
  assert.equal(check(dir).status, 0, 'without the flag the ledger is not required');

  // One verdict recorded, two still open.
  assert.equal(ac(dir, 'set', 'AC-1', 'proven', '--proof-mode', 'state').status, 0);
  result = check(dir, '--require-acceptance-status');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AC-2 has no verdict/);
  assert.match(result.stderr, /AC-3 has no verdict/);

  // weak and missing fail; untestable and proven pass.
  assert.equal(ac(dir, 'set', 'AC-2', 'weak').status, 0);
  assert.equal(ac(dir, 'set', 'AC-3', 'missing').status, 0);
  result = check(dir, '--require-acceptance-status');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AC-2 is weak: prove it, or record `untestable` with a note/);
  assert.match(result.stderr, /AC-3 is missing: prove it/);
  assert.equal(ac(dir, 'set', 'AC-2', 'untestable', '--note', 'No client reaches it.').status, 0);
  assert.equal(ac(dir, 'set', 'AC-3', 'proven', '--proof-mode', 'mixed').status, 0);
  assert.equal(check(dir, '--require-acceptance-status').status, 0);

  // A criterion the handoff does not list cannot hide in the ledger.
  const ledger = ledgerOf(dir);
  ledger.criteria.push({ ...ledger.criteria[0], id: 'AC-4' });
  writeFileSync(
    path.join(dir, 'artifacts', 'acceptance-status.json'),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
  result = check(dir, '--require-acceptance-status');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AC-4 is not an acceptance criterion of this task/);
}

{
  // A flow may waive weak verdicts through its terminal contract.
  const contract = {
    schemaVersion: 1,
    flowType: 'dev',
    requireSignal: true,
    acceptance: { allowWeak: true },
    commands: {
      complete: { artifacts: [] },
      'no-change': { artifacts: [] },
      blocked: { artifacts: [] },
    },
    whenPresent: [],
    resolvedAt: '2026-09-19T10:00:00.000Z',
    source: 'project',
  };
  const dir = makeTask({ contract });
  const contractPath = path.join(dir, 'inputs', 'worker-terminal-contract.json');
  assert.equal(ac(dir, 'set', 'AC-1', 'weak').status, 0);
  assert.equal(ac(dir, 'set', 'AC-2', 'missing').status, 0);
  assert.equal(ac(dir, 'set', 'AC-3', 'proven', '--proof-mode', 'state').status, 0);
  const waived = check(
    dir,
    '--require-acceptance-status',
    '--contract',
    contractPath,
    '--terminal',
    'complete',
  );
  assert.equal(waived.status, 0, waived.stderr);

  // The same ledger without the waiver fails, so the waiver is what passed it.
  writeFileSync(
    contractPath,
    `${JSON.stringify({ ...contract, acceptance: undefined }, null, 2)}\n`,
  );
  const strict = check(
    dir,
    '--require-acceptance-status',
    '--contract',
    contractPath,
    '--terminal',
    'complete',
  );
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /AC-1 is weak/);

  // Even with the waiver, a criterion with no verdict at all still fails.
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  const ledger = ledgerOf(dir);
  ledger.criteria = ledger.criteria.filter((entry) => entry.id !== 'AC-2');
  writeFileSync(
    path.join(dir, 'artifacts', 'acceptance-status.json'),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
  const stillOpen = check(
    dir,
    '--require-acceptance-status',
    '--contract',
    contractPath,
    '--terminal',
    'complete',
  );
  assert.equal(stillOpen.status, 1);
  assert.match(stillOpen.stderr, /AC-2 has no verdict/);
}

// ---------------------------------------------------------------------------
// 9. The writer itself never puts an invalid ledger on disk, whoever calls it.
{
  const dir = makeTask();
  const file = path.join(dir, 'artifacts', 'acceptance-status.json');
  assert.throws(
    () =>
      writeAcceptanceLedger(dir, {
        schemaVersion: 1,
        criteria: [{ id: 'AC-1', text: 'x', verdict: 'nope', evidence: [], recipeNodes: [] }],
      }),
    (error) =>
      error instanceof AcceptanceRefusal &&
      /refusing to write an invalid artifacts\/acceptance-status\.json/.test(error.message) &&
      /criteria\[0\]\.verdict/.test(error.message),
  );
  assert.equal(existsSync(file), false, 'a refused write leaves no file behind');
}

// ---------------------------------------------------------------------------
// 10. The mark engine gates the check on the project's opt-in.
{
  const engine = path.join(root, 'scripts', 'mark-checklist-step.cjs');
  const contract = (acceptance) => ({
    schemaVersion: 1,
    flowType: 'dev',
    requireSignal: true,
    ...(acceptance ? { acceptance } : {}),
    commands: {
      complete: { artifacts: [] },
      'no-change': { artifacts: [] },
      blocked: { artifacts: [] },
    },
    whenPresent: [],
    resolvedAt: '2026-09-19T10:00:00.000Z',
    source: 'project',
  });

  function completeWith(acceptance) {
    const dir = makeTask({ contract: contract(acceptance) });
    writeFileSync(path.join(dir, 'CHECKLIST.md'), '- [x] **1. do the work**\n');
    const result = spawnSync(process.execPath, [engine, dir, 'complete', '--mark-last'], {
      encoding: 'utf8',
    });
    return { dir, result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }

  // The state every farm is in today: criteria on the ticket, no ledger written,
  // and no opt-in. `complete` must pass — enforcing here would fail every run.
  const optedOut = completeWith(undefined);
  assert.equal(
    optedOut.result.status,
    0,
    `complete must pass without worker_terminal.acceptance.require: ${optedOut.output}`,
  );

  // With the opt-in the same task is refused until every criterion has a verdict.
  const optedIn = completeWith({ require: true });
  assert.notEqual(optedIn.result.status, 0, 'complete must fail with require: true and no ledger');
  assert.match(optedIn.output, /acceptance-status\.json is missing/);
}

// ---------------------------------------------------------------------------
// 11. Under the opt-in, a handoff the engine cannot read refuses `complete`.
{
  const engine = path.join(root, 'scripts', 'mark-checklist-step.cjs');
  const optInContract = {
    schemaVersion: 1,
    flowType: 'dev',
    requireSignal: true,
    acceptance: { require: true },
    commands: {
      complete: { artifacts: [] },
      'no-change': { artifacts: [] },
      blocked: { artifacts: [] },
    },
    whenPresent: [],
    resolvedAt: '2026-09-19T10:00:00.000Z',
    source: 'project',
  };

  function completeWithHandoff(body) {
    const dir = makeTask({ contract: optInContract });
    writeFileSync(path.join(dir, 'CHECKLIST.md'), '- [x] **1. do the work**\n');
    writeFileSync(path.join(dir, 'inputs', 'handoff.json'), body);
    const result = spawnSync(process.execPath, [engine, dir, 'complete', '--mark-last'], {
      encoding: 'utf8',
    });
    return { result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }

  // Invalid JSON: refused, naming the file, the same shape the gateway uses.
  const corrupt = completeWithHandoff('{ not json');
  assert.notEqual(corrupt.result.status, 0, 'a corrupt handoff must refuse complete');
  assert.match(corrupt.output, /cannot complete: invalid inputs\/handoff\.json/);
  assert.match(corrupt.output, /acceptance criteria \(ADR-060\)/);

  // A non-array `acceptanceCriteria` is the quiet version of the same problem:
  // the permissive reader turned it into "no criteria" and dropped the rule.
  const notAnArray = completeWithHandoff(
    `${JSON.stringify({ task: { acceptanceCriteria: 'one, two' } })}\n`,
  );
  assert.notEqual(notAnArray.result.status, 0, 'a non-array criteria list must refuse complete');
  assert.match(notAnArray.output, /task\.acceptanceCriteria must be an array/);

  // A handoff with no criteria key at all is not an error: nothing to enforce.
  const none = completeWithHandoff(`${JSON.stringify({ task: { title: 'no criteria' } })}\n`);
  assert.equal(none.result.status, 0, `a task with no criteria completes: ${none.output}`);
}

process.stdout.write('agent-runtime acceptance ledger tests: ok\n');
