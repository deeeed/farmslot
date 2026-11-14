#!/usr/bin/env node
// `mark sub` — child checklist units (ADR-060). Every refusal listed under
// "Child checklist units" in docs/reference/agent-runtime.md is asserted here,
// plus the parent signal effects: a child owns its parent step until it is
// settled, its completion ticks the parent box with a normal parent timing
// event, and a blocked child blocks the parent signal with the child reason.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const engine = path.join(root, 'scripts', 'mark-checklist-step.cjs');
const contractCheck = path.join(root, 'scripts', 'check-task-artifact-contract.mjs');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const PARENT_CHECKLIST = [
  '# Worker: dev — DEMO-1',
  '',
  '## Checklist',
  '',
  '- [ ] **1. Prepare the branch**',
  '- [ ] **2. Review the diff against the review skill** — follow the child unit',
  '- [ ] **3. Ship it**',
  '',
].join('\n');

const SKILL_SOURCE = [
  '---',
  'name: review-skill',
  'description: A checklist-shaped skill.',
  '---',
  '# Review skill',
  '',
  '## Rules',
  '',
  '- [ ] informational box in a skipped section',
  '',
  '## Review',
  '',
  '- [ ] **1. Read the diff under {{TASK_DIR}}**',
  '- [ ] **2. Check the {{FLOW}} patterns**',
  '',
].join('\n');

const taskDirectories = new Set();
process.once('exit', () => {
  for (const directory of taskDirectories) rmSync(directory, { recursive: true, force: true });
});

function makeTask({ checklist = PARENT_CHECKLIST } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-sub-'));
  taskDirectories.add(dir);
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  writeFileSync(path.join(dir, 'CHECKLIST.md'), checklist);
  writeFileSync(
    path.join(dir, 'inputs', 'handoff.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        attemptId: 'handoff-attempt',
        surface: 'test',
        project: 'demo',
        domain: '',
        flow: 'dev',
        task: { title: 'Demo', sourceKind: 'text', ticket: 'DEMO-1' },
        taskDocument: 'TASK.md',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(dir, 'skill.md'), SKILL_SOURCE);
  return dir;
}

function mark(dir, ...args) {
  return spawnSync(process.execPath, [engine, dir, ...args], { encoding: 'utf8' });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parentSignal(dir) {
  return readJson(path.join(dir, 'SIGNAL.json'));
}

/**
 * ADR-060: a child signal never carries `failed`. Work that cannot finish is
 * `blocked` with a reason, so the operator uses the existing blocked-run
 * actions. Enforced on every read below, which is how every child signal write
 * in this file is observed — a new verb cannot skip the guard.
 */
function assertChildStatusAllowed(signal) {
  assert.ok(
    ['running', 'blocked', 'complete', 'done'].includes(signal.status),
    `a child signal status must be running|blocked|complete|done, never failed (got ${signal.status})`,
  );
}

function childSignal(dir, id) {
  const signal = readJson(path.join(dir, 'subtasks', `${id}-SIGNAL.json`));
  assertChildStatusAllowed(signal);
  return signal;
}

function index(dir) {
  return readJson(path.join(dir, 'subtasks', 'index.json'));
}
module.exports = {
  assert,
  createHash,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  tmpdir,
  path,
  spawnSync,
  root,
  engine,
  contractCheck,
  sha256,
  PARENT_CHECKLIST,
  SKILL_SOURCE,
  makeTask,
  mark,
  readJson,
  parentSignal,
  assertChildStatusAllowed,
  childSignal,
  index,
};
