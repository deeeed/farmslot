#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const usageLine =
  'usage: mark <step-number> [--status running|complete|blocked|failed|done] [--outcome success|partial|failure] [--disposition fixed|blocked|failed|already_fixed|not_reproducible] [--reason text]';

function printHelp() {
  console.log(
    [
      usageLine,
      '',
      'Marks one TASK.md/CHECKLIST.md checkbox complete and records a compact checklistTiming event in SIGNAL.json.',
      'Use the visible 1-based checklist step number: ./mark 1, ./mark 2, ...',
      'Safe to rerun: an already-recorded step is not duplicated.',
      'Final step example: ./mark 15 --status complete --outcome success',
    ].join('\n'),
  );
}

function usage() {
  console.error(usageLine);
  console.error('run ./mark --help for details');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  printHelp();
  process.exit(0);
}

const [taskPath, signalPath, stepRaw, ...rest] = args;
if (stepRaw === '--help' || stepRaw === '-h') {
  printHelp();
  process.exit(0);
}
if (!taskPath || !signalPath || !stepRaw) usage();
const stepNumber = Number(stepRaw);
if (!Number.isInteger(stepNumber) || stepNumber < 1) usage();

const allowedStatus = new Set(['running', 'complete', 'blocked', 'failed', 'done']);
const allowedOutcome = new Set(['success', 'partial', 'failure']);
const allowedDisposition = new Set([
  'fixed',
  'blocked',
  'failed',
  'already_fixed',
  'not_reproducible',
]);

const opts = {};
for (let i = 0; i < rest.length; i += 1) {
  const key = rest[i];
  const value = rest[i + 1];
  if (!key?.startsWith('--') || value === undefined) usage();
  opts[key.slice(2)] = value;
  i += 1;
}

if (opts.status && !allowedStatus.has(opts.status)) usage();
if (opts.outcome && !allowedOutcome.has(opts.outcome)) usage();
if (opts.disposition && !allowedDisposition.has(opts.disposition)) usage();

function atomicWrite(file, content, mode) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

function stripLabel(raw) {
  return raw
    .replace(/^\*\*(.*?)\*\*\s*[—-]?\s*/, '$1 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const original = fs.readFileSync(taskPath, 'utf8');
const lines = original.split(/\n/);
let inFence = false;
let seen = 0;
let target = null;

for (let i = 0; i < lines.length; i += 1) {
  if (/^\s*```/.test(lines[i])) {
    inFence = !inFence;
    continue;
  }
  if (inFence) continue;
  const match = lines[i].match(/^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.*)$/);
  if (!match) continue;
  seen += 1;
  if (seen !== stepNumber) continue;
  const label = stripLabel(match[4]);
  if (match[2] === ' ') lines[i] = `${match[1]}x${match[3]}${match[4]}`;
  target = { stepNumber, label };
  break;
}

if (!target) {
  console.error(`checklist step ${stepNumber} not found in ${taskPath}`);
  process.exit(1);
}

const updated = lines.join('\n');
if (updated !== original) atomicWrite(taskPath, updated);

const now = new Date().toISOString();
const signal = readJson(signalPath);
const timing =
  signal.checklistTiming && typeof signal.checklistTiming === 'object'
    ? signal.checklistTiming
    : { schemaVersion: 1, source: path.basename(taskPath), events: [] };
const events = Array.isArray(timing.events) ? timing.events : [];
if (
  !events.some(
    (event) =>
      event &&
      (event.stepNumber === target.stepNumber || event.index === target.stepNumber - 1),
  )
) {
  events.push({ stepNumber: target.stepNumber, label: target.label, checkedAt: now });
}

const next = {
  ...signal,
  status: opts.status || signal.status || 'running',
  ...(opts.outcome ? { outcome: opts.outcome } : {}),
  ...(opts.disposition ? { disposition: opts.disposition } : {}),
  ...(opts.reason ? { reason: opts.reason } : {}),
  step: target.label || signal.step,
  checklistTiming: { schemaVersion: 1, source: timing.source || path.basename(taskPath), events },
  timestamp: now,
};

atomicWrite(signalPath, `${JSON.stringify(next, null, 2)}\n`, 0o644);
console.log(`marked ${stepNumber}: ${target.label}`);
