#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const COMPLETE_COMMANDS = new Set(['complete', 'finish']);
const START_COMMANDS = new Set(['start']);
const usageLine =
  'usage: mark <step-number|start|complete> [--status ...] [--outcome ...] [--disposition ...] [--reason text] [--needsSelfReview true|false] [--mark-last]';

function printHelp() {
  console.log(
    [
      usageLine,
      '',
      'Bootstrap: ./mark start — worker-owned SIGNAL.json with status running (no checklist box).',
      'Progress: ./mark 1, ./mark 2, ... — checks the box and appends checklistTiming.',
      'Terminal: ./mark complete [--outcome success] — merges into SIGNAL.json; never truncates history.',
      'Optional: --mark-last also checks the last unchecked checklist item.',
      'Do not use echo > SIGNAL.json.',
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
  if (key === '--mark-last') {
    opts.markLast = true;
    continue;
  }
  const value = rest[i + 1];
  if (!key?.startsWith('--') || value === undefined) usage();
  opts[key.slice(2)] = value;
  i += 1;
}

if (opts.status && !allowedStatus.has(opts.status)) usage();
if (opts.outcome && !allowedOutcome.has(opts.outcome)) usage();
if (opts.disposition && !allowedDisposition.has(opts.disposition)) usage();
if (opts.needsSelfReview && opts.needsSelfReview !== 'true' && opts.needsSelfReview !== 'false') {
  usage();
}

const stepToken = String(stepRaw).toLowerCase();
const isCompleteCommand = COMPLETE_COMMANDS.has(stepToken);
const isStartCommand = START_COMMANDS.has(stepToken);
let stepNumber = null;
if (!isCompleteCommand && !isStartCommand) {
  stepNumber = Number(stepRaw);
  if (!Number.isInteger(stepNumber) || stepNumber < 1) usage();
}
if (isStartCommand && (opts.status || opts.outcome || opts.disposition || opts.markLast)) usage();
if (isCompleteCommand && !opts.status) opts.status = 'complete';

const TERMINAL_STATUS = new Set(['complete', 'blocked', 'failed', 'done']);
const SIGNAL_PASSTHROUGH_KEYS = ['role', 'contextId', 'prNumber'];

function pickSignalPassthrough(signal) {
  const out = {};
  for (const key of SIGNAL_PASSTHROUGH_KEYS) {
    if (signal[key] !== undefined) out[key] = signal[key];
  }
  return out;
}

function buildSignalUpdate(signal, opts, target, timing, events, now, taskPath) {
  const isTerminal = Boolean(opts.status && TERMINAL_STATUS.has(opts.status));
  const base = {
    ...pickSignalPassthrough(signal),
    step: target?.label ?? signal.step ?? 'complete',
    checklistTiming: {
      schemaVersion: 1,
      source: timing.source || path.basename(taskPath),
      events,
    },
    timestamp: now,
  };
  if (isTerminal) {
    return {
      ...base,
      status: opts.status,
      ...(opts.outcome ? { outcome: opts.outcome } : {}),
      ...(opts.disposition ? { disposition: opts.disposition } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.needsSelfReview
        ? { needsSelfReview: opts.needsSelfReview === 'true' }
        : {}),
    };
  }
  return {
    ...base,
    status: 'running',
  };
}

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

function parseChecklist(markdown) {
  const lines = markdown.split(/\n/);
  const items = [];
  let inFence = false;
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = lines[i].match(/^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.*)$/);
    if (!match) continue;
    seen += 1;
    items.push({
      lineIndex: i,
      stepNumber: seen,
      checked: match[2].toLowerCase() === 'x',
      prefix: match[1],
      suffix: match[3],
      rawLabel: match[4],
      label: stripLabel(match[4]),
    });
  }
  return { lines, items };
}

function markStepInLines(lines, item) {
  if (item.checked) return false;
  lines[item.lineIndex] = `${item.prefix}x${item.suffix}${item.rawLabel}`;
  return true;
}

function resolveTarget(taskPath, stepNumber, markLast) {
  const original = fs.readFileSync(taskPath, 'utf8');
  const parsed = parseChecklist(original);
  let item = null;
  if (stepNumber != null) {
    item = parsed.items.find((entry) => entry.stepNumber === stepNumber) ?? null;
    if (!item) {
      console.error(`checklist step ${stepNumber} not found in ${taskPath}`);
      process.exit(1);
    }
  } else if (markLast) {
    const unchecked = parsed.items.filter((entry) => !entry.checked);
    item = unchecked.length ? unchecked[unchecked.length - 1] : null;
  }
  let updated = original;
  if (item) {
    const nextLines = [...parsed.lines];
    markStepInLines(nextLines, item);
    updated = nextLines.join('\n');
    if (updated !== original) atomicWrite(taskPath, updated);
  }
  return item
    ? { stepNumber: item.stepNumber, label: item.label }
    : { stepNumber: null, label: 'complete' };
}

const target = isStartCommand
  ? { stepNumber: null, label: 'started' }
  : resolveTarget(taskPath, stepNumber, Boolean(isCompleteCommand && opts.markLast));

const now = new Date().toISOString();
const signal = readJson(signalPath);
const timing =
  signal.checklistTiming && typeof signal.checklistTiming === 'object'
    ? signal.checklistTiming
    : { schemaVersion: 1, source: path.basename(taskPath), events: [] };
const events = Array.isArray(timing.events) ? [...timing.events] : [];

if (
  !isStartCommand &&
  target.stepNumber != null &&
  !events.some(
    (event) =>
      event &&
      (event.stepNumber === target.stepNumber || event.index === target.stepNumber - 1),
  )
) {
  events.push({ stepNumber: target.stepNumber, label: target.label, checkedAt: now });
}

const next = buildSignalUpdate(signal, opts, target, timing, events, now, taskPath);
atomicWrite(signalPath, `${JSON.stringify(next, null, 2)}\n`, 0o644);

if (isStartCommand) {
  console.log('signal started');
} else if (isCompleteCommand) {
  console.log(`signal complete: status=${next.status}${next.outcome ? ` outcome=${next.outcome}` : ''}`);
} else {
  console.log(`marked ${target.stepNumber}: ${target.label}`);
}
