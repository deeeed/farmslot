#!/usr/bin/env tsx
/**
 * E2E for child checklist units (ADR-060 phase 1): a REAL task directory
 * written by `task init` from the repository's own worker template, a REAL
 * checklist-shaped skill fixture as the child source, and every command driven
 * through the task dir's own `./mark` shim — never the engine path directly.
 *
 * Assertions read files only (checklists, SIGNAL.json, subtasks/index.json), the
 * way the gateway and every client observe a run.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root from this file's location, not cwd: the package `test` script runs
// it from packages/agent-runtime, and `yarn e2e:subtask-mark` from the root.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const taskInitCli = path.join(root, 'packages', 'agent-runtime', 'scripts', 'task-init-cli.mjs');
const agentRuntimeDist = path.join(root, 'packages', 'agent-runtime', 'dist', 'index.js');
const skillFixture = path.join('scripts', 'fixtures', 'subtask-skill.md');
const OWNING_STEP = 5;
const SECOND_STEP = 9;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function run(command: string, args: string[], options: { cwd?: string } = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
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

/**
 * ADR-060: a child signal never carries `failed`. Work that cannot finish is
 * `blocked` with a reason. Every child signal read below goes through this, so
 * no step of the scenario can observe a forbidden status unchecked.
 */
function readChildSignal(file: string): Record<string, unknown> {
  const signal = readJson(file);
  assert.ok(
    ['running', 'blocked', 'complete', 'done'].includes(signal.status as string),
    `a child signal status must be running|blocked|complete|done, never failed (got ${String(signal.status)})`,
  );
  return signal;
}

function checkedSteps(file: string): number {
  return (readFileSync(file, 'utf-8').match(/^- \[x\]/gm) ?? []).length;
}

function isStepChecked(file: string, stepNumber: number): boolean {
  const rows = readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => /^- \[( |x)\]/.test(line.trim()));
  const row = rows[stepNumber - 1];
  assert.ok(row, `step ${stepNumber} must exist in ${path.basename(file)}`);
  return row.trim().startsWith('- [x]');
}

function main() {
  if (!existsSync(agentRuntimeDist)) {
    console.log('[e2e] building @farmslot/agent-runtime (task init needs dist/)');
    ok('yarn', ['workspace', '@farmslot/agent-runtime', 'build'], 'agent-runtime build');
  }

  const work = mkdtempSync(path.join(tmpdir(), 'farmslot-e2e-subtask-'));
  const taskDir = path.join(work, 'temp', 'tasks', 'ci-fix', 'subtask-e2e');
  const mark = path.join(taskDir, 'mark');

  try {
    // 1. A real task directory from the repository's own worker template.
    ok(
      'node',
      [
        taskInitCli,
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
        'Sub-task observability E2E',
        '--task-text',
        'Drive mark sub through a real task directory.',
        '--surface',
        'test',
        '--project',
        'farmslot',
        '--var',
        'PR_NUMBER=1',
        '--var',
        'GH_REPO=deeeed/farmslot',
        '--var',
        'BRANCH=feat/subtask-observability-phase1',
        '--var',
        'CI_ISSUE_TYPE=lint',
        '--var',
        'CI_ISSUES=- lint failed on one file',
        `--var`,
        `REPO=${root}`,
      ],
      'task init',
    );
    const parentChecklist = path.join(taskDir, 'CHECKLIST.md');
    const parentSignalFile = path.join(taskDir, 'SIGNAL.json');
    for (const file of ['CHECKLIST.md', 'TASK.md', 'mark', 'inputs/handoff.json']) {
      assert.ok(existsSync(path.join(taskDir, file)), `task init must write ${file}`);
    }

    // 2. Start the attempt and walk the parent up to the owning step.
    ok(mark, ['start'], 'mark start');
    const attemptId = readJson(parentSignalFile).attemptId;
    assert.ok(attemptId, 'mark start must record an attemptId');
    for (let step = 1; step < OWNING_STEP; step += 1) {
      ok(mark, [String(step)], `mark ${step}`);
    }
    assert.equal(checkedSteps(parentChecklist), OWNING_STEP - 1);

    // 3. Register a child unit from the real checklist-shaped skill fixture.
    ok(
      mark,
      ['sub', 'start', 'ci-parity', '--step', String(OWNING_STEP), '--from', skillFixture],
      'sub start',
    );
    const childChecklist = path.join(taskDir, 'subtasks', 'ci-parity.md');
    const childSignalFile = path.join(taskDir, 'subtasks', 'ci-parity-SIGNAL.json');
    const indexFile = path.join(taskDir, 'subtasks', 'index.json');
    const registry = readJson(indexFile) as {
      schemaVersion: number;
      units: Array<Record<string, any>>;
    };
    assert.equal(registry.schemaVersion, 1);
    assert.equal(registry.units.length, 1);
    assert.deepEqual(registry.units[0].parent, {
      checklist: 'CHECKLIST.md',
      stepNumber: OWNING_STEP,
    });
    assert.equal(registry.units[0].source.kind, 'skill');
    assert.equal(registry.units[0].source.ref, skillFixture);
    assert.equal(
      registry.units[0].source.sha256,
      sha256(readFileSync(path.join(root, skillFixture), 'utf-8')),
      'the index records the digest of the skill source before rendering',
    );
    assert.equal(
      registry.units[0].source.renderedSha256,
      sha256(readFileSync(childChecklist, 'utf-8')),
      'the index records the digest of the child checklist as written',
    );
    const childMarkdown = readFileSync(childChecklist, 'utf-8');
    assert.ok(!childMarkdown.startsWith('---'), 'the skill frontmatter is stripped');
    assert.ok(childMarkdown.includes(taskDir), '{{TASK_DIR}} is rendered in the child checklist');
    // Four raw checkboxes, but only three are steps (the Rules box is in an
    // informational section).
    assert.equal((childMarkdown.match(/^- \[( |x)\]/gm) ?? []).length, 4);
    const childSignal = readChildSignal(childSignalFile);
    assert.equal(childSignal.role, 'subtask');
    assert.equal(childSignal.contextId, 'ci-parity');
    assert.equal(childSignal.attemptId, attemptId, 'the child shares the parent attempt');
    assert.equal(childSignal.status, 'running');

    // 4. The parent cannot mark the step its child owns.
    refused(
      mark,
      [String(OWNING_STEP)],
      /step 5 is owned by subtask ci-parity; finish it with \.\/mark sub ci-parity complete/,
      `mark ${OWNING_STEP} while the child runs`,
    );
    assert.equal(isStepChecked(parentChecklist, OWNING_STEP), false);

    // 5. Child steps land on the child pair only.
    ok(mark, ['sub', 'ci-parity', '1'], 'sub 1');
    assert.equal(
      isStepChecked(childChecklist, 2),
      true,
      'child step 1 is the second box (Rules is skipped)',
    );
    assert.equal((readChildSignal(childSignalFile).checklistTiming as any).events.length, 1);
    assert.equal(readJson(parentSignalFile).status, 'running');

    // 6. Child blocked blocks the parent signal with the child reason.
    ok(
      mark,
      ['sub', 'ci-parity', 'blocked', '--reason', 'the lint job log is not fetchable'],
      'sub blocked',
    );
    assert.equal(readChildSignal(childSignalFile).status, 'blocked');
    assert.equal(readChildSignal(childSignalFile).disposition, 'blocked');
    let parentSignal = readJson(parentSignalFile);
    assert.equal(parentSignal.status, 'blocked');
    assert.equal(parentSignal.reason, 'subtask ci-parity: the lint job log is not fetchable');
    // A blocked child still owns the step.
    refused(
      mark,
      [String(OWNING_STEP)],
      /step 5 is owned by subtask ci-parity/,
      `mark ${OWNING_STEP} while the child is blocked`,
    );

    // 7. Resuming the child restores running on both signals.
    ok(mark, ['sub', 'ci-parity', '2'], 'sub 2 after blocked');
    assert.equal(readChildSignal(childSignalFile).status, 'running');
    parentSignal = readJson(parentSignalFile);
    assert.equal(parentSignal.status, 'running');
    assert.equal(parentSignal.reason, undefined, 'the child reason clears on resume');

    // 8. Child completion ticks the parent box with a normal parent timing event.
    mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
    writeFileSync(
      path.join(taskDir, 'artifacts', 'ci-parity.md'),
      '# CI parity\n\nlint reproduced locally, same failure.\n',
    );
    refused(
      mark,
      ['sub', 'ci-parity', 'complete', '--report', 'artifacts/nope.md'],
      /missing required artifact: artifacts\/nope\.md/,
      'sub complete with a missing report',
    );
    ok(
      mark,
      ['sub', 'ci-parity', 'complete', '--mark-last', '--report', 'artifacts/ci-parity.md'],
      'sub complete',
    );
    assert.equal(readChildSignal(childSignalFile).status, 'complete');
    assert.equal(isStepChecked(parentChecklist, OWNING_STEP), true, 'the parent box is ticked');
    parentSignal = readJson(parentSignalFile);
    assert.equal(parentSignal.status, 'running');
    const parentEvents = (parentSignal.checklistTiming as any).events as Array<{
      stepNumber: number;
      label: string;
    }>;
    const owningEvent = parentEvents.find((event) => event.stepNumber === OWNING_STEP);
    assert.ok(owningEvent, 'child completion appends the parent timing event');
    assert.match(owningEvent.label, /^5\. /, 'the parent event carries the parent step name');
    // A later parent mark of that step is an idempotent no-op. Re-read the
    // signal: asserting against the array captured above would pass even if the
    // second mark appended a duplicate event.
    ok(mark, [String(OWNING_STEP)], `mark ${OWNING_STEP} after the child completed`);
    const eventsAfterReMark = ((readJson(parentSignalFile).checklistTiming as any).events ??
      []) as Array<{ stepNumber: number }>;
    assert.equal(
      eventsAfterReMark.filter((event) => event.stepNumber === OWNING_STEP).length,
      1,
      'the parent event is not duplicated',
    );

    // 9. A second open child refuses the parent terminal mark.
    for (const step of [6, 7, 8]) ok(mark, [String(step)], `mark ${step}`);
    ok(
      mark,
      [
        'sub',
        'start',
        'evidence-pack',
        '--step',
        String(SECOND_STEP),
        '--from',
        'inline:- [ ] **1. write the report and learnings**\n',
      ],
      'sub start (inline source)',
    );
    writeFileSync(
      path.join(taskDir, 'artifacts', 'report.md'),
      '# Report\n\nCI parity restored.\n',
    );
    writeFileSync(path.join(taskDir, 'artifacts', 'learnings.md'), '- Lint parity gate first.\n');
    refused(
      mark,
      ['complete', '--mark-last'],
      /cannot complete while a subtask is open: evidence-pack \(running\)/,
      'parent complete with an open child',
    );
    assert.notEqual(readJson(parentSignalFile).status, 'complete');

    // 10. With every child settled the parent terminal path runs as usual.
    ok(mark, ['sub', 'evidence-pack', 'complete', '--mark-last'], 'sub complete (second child)');
    assert.equal(isStepChecked(parentChecklist, SECOND_STEP), true);
    ok(mark, ['complete', '--mark-last'], 'parent complete');
    parentSignal = readJson(parentSignalFile);
    assert.equal(parentSignal.status, 'complete');
    assert.equal(parentSignal.outcome, 'success');
    assert.equal(
      (readJson(indexFile) as { units: unknown[] }).units.length,
      2,
      'both child units stay registered',
    );
    console.log('e2e:subtask-mark ok — 2 child units, every refusal observed on files');
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
