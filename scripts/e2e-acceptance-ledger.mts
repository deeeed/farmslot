#!/usr/bin/env tsx
/**
 * E2E for the acceptance-criteria ledger (ADR-060 phase 5): a REAL task directory
 * written by `task init` from the repository's own worker template with three
 * acceptance criteria, every verdict recorded through the real `farmslot-agent ac`
 * entry point, and the terminal gate driven through the task dir's own `./mark`
 * shim — never the engine path directly.
 *
 * Assertions read files and CLI output only (handoff.json, the ledger, SIGNAL.json),
 * the way the gateway and every client observe a run.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root from this file's location, not cwd: the package `test` script runs it
// from packages/agent-runtime, and `yarn e2e:acceptance-ledger` from the root.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentBin = path.join(root, 'packages', 'agent-runtime', 'bin', 'farmslot-agent.mjs');
const agentRuntimeDist = path.join(root, 'packages', 'agent-runtime', 'dist', 'index.js');
const require = createRequire(import.meta.url);
const { enumerateChecklistCheckboxes } = require(
  path.join(root, 'packages', 'agent-runtime', 'scripts', 'checklist-target.cjs'),
) as { enumerateChecklistCheckboxes: (markdown: string) => unknown[] };

const CRITERIA = [
  'The lint gate fails the build when a file regresses.',
  'The failure names the offending file.',
  'The fix is covered by a regression test.',
];

function run(command: string, args: string[]) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf-8', stdio: 'pipe' });
}

function ok(command: string, args: string[], label: string) {
  const result = run(command, args);
  assert.equal(
    result.status,
    0,
    `${label} must succeed: exit ${result.status}\n${result.stderr}${result.stdout}`,
  );
  return result;
}

function refused(command: string, args: string[], pattern: RegExp, label: string) {
  const result = run(command, args);
  assert.notEqual(
    result.status,
    0,
    `${label} must be refused, but it succeeded:\n${result.stdout}`,
  );
  assert.match(`${result.stderr}${result.stdout}`, pattern, `${label} refusal message`);
  return result;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

function main() {
  if (!existsSync(agentRuntimeDist)) {
    console.log('[e2e] building @farmslot/agent-runtime (task init needs dist/)');
    ok('yarn', ['workspace', '@farmslot/agent-runtime', 'build'], 'agent-runtime build');
  }

  const work = mkdtempSync(path.join(tmpdir(), 'farmslot-e2e-acceptance-'));
  const taskDir = path.join(work, 'temp', 'tasks', 'ci-fix', 'acceptance-e2e');
  const mark = path.join(taskDir, 'mark');
  const ac = (...args: string[]) => [
    agentBin,
    'ac',
    args[0],
    '--task-dir',
    taskDir,
    ...args.slice(1),
  ];

  try {
    // 1. A real task directory with three acceptance criteria.
    ok(
      'node',
      [
        agentBin,
        'task',
        'init',
        taskDir,
        '--flow',
        'ci-fix',
        '--platform',
        'cli',
        '--template',
        'ci-fix/default',
        '--project-worker',
        path.join('templates', 'worker'),
        '--title',
        'Acceptance ledger E2E',
        '--task-text',
        'Record a verdict for every acceptance criterion through `farmslot-agent ac`.',
        ...CRITERIA.flatMap((criterion) => ['--acceptance', criterion]),
        '--surface',
        'test',
        '--project',
        'farmslot',
        '--var',
        'PR_NUMBER=1',
        '--var',
        'GH_REPO=deeeed/farmslot',
        '--var',
        'BRANCH=feat/subtask-observability-phase5',
        '--var',
        'CI_ISSUE_TYPE=lint',
        '--var',
        'CI_ISSUES=- lint failed on one file',
        '--var',
        `REPO=${root}`,
      ],
      'task init',
    );
    // Ledger enforcement is opt-in per project (`worker_terminal.acceptance`), and
    // this scenario proves the enforcement, so the run's own contract asks for it —
    // the same file a project with that config produces.
    const contractPath = path.join(taskDir, 'inputs', 'worker-terminal-contract.json');
    writeFileSync(
      contractPath,
      `${JSON.stringify({ ...readJson(contractPath), acceptance: { require: true } }, null, 2)}\n`,
    );

    const handoff = readJson(path.join(taskDir, 'inputs', 'handoff.json'));
    assert.deepEqual(
      (handoff.task as { acceptanceCriteria: string[] }).acceptanceCriteria,
      CRITERIA,
      'task init records the criteria in order — that order is the AC-<N> id',
    );
    const taskMarkdown = readFileSync(path.join(taskDir, 'TASK.md'), 'utf-8');
    for (const criterion of CRITERIA) {
      assert.ok(taskMarkdown.includes(`- ${criterion}`), 'TASK.md still renders the AC list');
    }
    assert.doesNotMatch(taskMarkdown, /- \[[ xX]\]/, 'TASK.md carries no checkbox');

    // 2. Nothing is recorded until `ac set` runs, and `render` says so.
    const listed = ok('node', ac('list'), 'ac list');
    const rows = JSON.parse(listed.stdout) as Array<{ id: string; verdict: string | null }>;
    assert.deepEqual(
      rows.map((row) => row.id),
      ['AC-1', 'AC-2', 'AC-3'],
    );
    assert.deepEqual(
      rows.map((row) => row.verdict),
      [null, null, null],
    );
    refused('node', ac('render'), /no acceptance ledger yet/, 'ac render before any verdict');

    // 3. Real evidence files, then two of the three verdicts.
    const artifacts = path.join(taskDir, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, 'after-lint-gate.png'), 'png-bytes');
    writeFileSync(path.join(artifacts, 'lint-failure.log'), 'src/app.ts: 1 problem\n');
    refused(
      'node',
      ac('set', 'AC-1', 'proven', '--evidence', 'artifacts/not-captured.png'),
      /evidence path does not exist: artifacts\/not-captured\.png/,
      'a verdict pointing at evidence that was never captured',
    );
    ok(
      'node',
      ac(
        'set',
        'AC-1',
        'proven',
        '--proof-mode',
        'visual',
        '--evidence',
        'artifacts/after-lint-gate.png',
        '--recipe-node',
        'assert-lint-gate',
      ),
      'ac set AC-1',
    );
    ok(
      'node',
      ac(
        'set',
        'AC-2',
        'proven',
        '--proof-mode',
        'state',
        '--evidence',
        'artifacts/lint-failure.log',
        '--recipe-node',
        'assert-failure-names-file',
      ),
      'ac set AC-2',
    );

    // 4. Walk the checklist and try to finish with AC-3 unrecorded.
    ok(mark, ['start'], 'mark start');
    const checklistPath = path.join(taskDir, 'CHECKLIST.md');
    const totalSteps = enumerateChecklistCheckboxes(readFileSync(checklistPath, 'utf-8')).length;
    assert.ok(totalSteps > 1, 'the worker template enumerates steps');
    for (let step = 1; step < totalSteps; step += 1) ok(mark, [String(step)], `mark ${step}`);
    writeFileSync(path.join(artifacts, 'report.md'), '# Report\n\nLint parity restored.\n');
    writeFileSync(path.join(artifacts, 'learnings.md'), '- Ledger before the terminal mark.\n');
    refused(
      mark,
      ['complete', '--mark-last'],
      /AC-3 has no verdict/,
      'parent complete with one criterion unrecorded',
    );
    assert.notEqual(readJson(path.join(taskDir, 'SIGNAL.json')).status, 'complete');

    // 5. A `missing` verdict is a refusal too: recording one is not proving it.
    ok(
      'node',
      ac('set', 'AC-3', 'missing', '--note', 'No regression test yet.'),
      'ac set AC-3 missing',
    );
    refused(
      mark,
      ['complete', '--mark-last'],
      /AC-3 is missing: prove it, or record `untestable` with a note/,
      'parent complete with a missing verdict',
    );
    assert.notEqual(readJson(path.join(taskDir, 'SIGNAL.json')).status, 'complete');

    // 6. With every criterion proven the terminal path runs as usual.
    ok(
      'node',
      ac(
        'set',
        'AC-3',
        'proven',
        '--proof-mode',
        'state',
        '--recipe-node',
        'assert-regression-test',
      ),
      'ac set AC-3 proven',
    );
    ok(mark, ['complete', '--mark-last'], 'parent complete');
    const signal = readJson(path.join(taskDir, 'SIGNAL.json'));
    assert.equal(signal.status, 'complete');
    assert.equal(signal.outcome, 'success');

    // 7. The ledger is the one writer's file, and `render` is its table.
    const ledger = readJson(path.join(taskDir, 'artifacts', 'acceptance-status.json')) as {
      schemaVersion: number;
      criteria: Array<Record<string, unknown>>;
    };
    assert.equal(ledger.schemaVersion, 1);
    assert.deepEqual(
      ledger.criteria.map((criterion) => criterion.id),
      ['AC-1', 'AC-2', 'AC-3'],
    );
    assert.deepEqual(
      ledger.criteria.map((criterion) => criterion.verdict),
      ['proven', 'proven', 'proven'],
    );
    assert.equal(
      ledger.criteria[2].note,
      undefined,
      'the missing-verdict note does not survive the new verdict',
    );
    const rendered = ok('node', ac('render'), 'ac render').stdout;
    const expected = [
      '## Recipe coverage',
      '',
      '| AC | Criterion | Verdict | Proof mode | Recipe nodes | Evidence | Note |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      `| AC-1 | ${CRITERIA[0]} | PROVEN | visual | assert-lint-gate | artifacts/after-lint-gate.png | - |`,
      `| AC-2 | ${CRITERIA[1]} | PROVEN | state | assert-failure-names-file | artifacts/lint-failure.log | - |`,
      `| AC-3 | ${CRITERIA[2]} | PROVEN | state | assert-regression-test | - | - |`,
      '',
      'Overall recipe coverage: 3/3 ACs PROVEN (untestable: none, weak: 0, missing: 0)',
      '',
    ].join('\n');
    assert.equal(rendered, expected, 'ac render prints the coverage table');
    console.log('e2e:acceptance-ledger ok — 3 criteria, every refusal observed on files');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
