#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const START_COMMANDS = new Set(['start']);
const TERMINAL_COMMANDS = new Set(['complete', 'no-change', 'blocked']);
const NO_CHANGE_REPORT = path.join('artifacts', 'no-change-report.md');

const usageLine =
  'usage: mark <step-number|start|complete|no-change|blocked> [--reason text] [--already-fixed] [--mark-last] [--no-self-review]';

function printHelp() {
  console.log(
    [
      usageLine,
      '',
      'Bootstrap: ./mark start — worker-owned SIGNAL.json with status running (no checklist box).',
      'Progress: ./mark 1, ./mark 2, ... — checks the box and appends checklistTiming.',
      'Terminal:',
      '  ./mark complete [--mark-last] [--no-self-review]',
      '  ./mark no-change --reason "..." [--already-fixed] [--mark-last]',
      '  ./mark blocked --reason "..." [--mark-last]',
      'Do not write SIGNAL.json by hand or with echo.',
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

const opts = {};
for (let i = 0; i < rest.length; i += 1) {
  const key = rest[i];
  if (key === '--mark-last' || key === '--already-fixed' || key === '--no-self-review') {
    opts[key.slice(2)] = true;
    continue;
  }
  const value = rest[i + 1];
  if (!key?.startsWith('--') || value === undefined) usage();
  opts[key.slice(2)] = value;
  i += 1;
}

const stepToken = String(stepRaw).toLowerCase();
const isStartCommand = START_COMMANDS.has(stepToken);
const terminalCommand = TERMINAL_COMMANDS.has(stepToken) ? stepToken : null;
let stepNumber = null;
if (!isStartCommand && !terminalCommand) {
  stepNumber = Number(stepRaw);
  if (!Number.isInteger(stepNumber) || stepNumber < 1) usage();
}

if (isStartCommand && Object.keys(opts).length > 0) usage();
if (terminalCommand === 'no-change' || terminalCommand === 'blocked') {
  if (!opts.reason?.trim()) {
    console.error(`${terminalCommand} requires --reason`);
    process.exit(1);
  }
}

const SIGNAL_PASSTHROUGH_KEYS = ['role', 'contextId', 'prNumber'];

function pickSignalPassthrough(signal) {
  const out = {};
  for (const key of SIGNAL_PASSTHROUGH_KEYS) {
    if (signal[key] !== undefined) out[key] = signal[key];
  }
  return out;
}

function resolveTerminalPreset(command) {
  switch (command) {
    case 'complete':
      return { status: 'complete', outcome: 'success', disposition: 'fixed' };
    case 'no-change':
      return {
        status: 'complete',
        outcome: 'success',
        disposition: opts['already-fixed'] ? 'already_fixed' : 'not_reproducible',
      };
    case 'blocked':
      return { status: 'blocked', outcome: 'partial', disposition: 'blocked' };
    default:
      usage();
      return null;
  }
}

function assertNoChangeReport(taskDir) {
  const reportAbs = path.join(taskDir, NO_CHANGE_REPORT);
  if (!fs.existsSync(reportAbs) || fs.statSync(reportAbs).size === 0) {
    console.error(`missing required report: ${NO_CHANGE_REPORT}`);
    process.exit(1);
  }
  return NO_CHANGE_REPORT;
}

function buildSignalUpdate(signal, terminal, target, timing, events, now, taskPath, taskDir) {
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

  if (!terminal) {
    return { ...base, status: 'running' };
  }

  const preset = resolveTerminalPreset(terminal.command);
  const next = {
    ...base,
    status: preset.status,
    outcome: preset.outcome,
    disposition: preset.disposition,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(terminal.command === 'complete' && opts['no-self-review']
      ? { needsSelfReview: false }
      : {}),
  };

  if (terminal.command === 'no-change') {
    next.evidence = { reportPath: assertNoChangeReport(taskDir) };
  }

  return next;
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

const taskDir = path.dirname(signalPath);
const target = isStartCommand
  ? { stepNumber: null, label: 'started' }
  : resolveTarget(taskPath, stepNumber, Boolean(terminalCommand && opts['mark-last']));

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
      event && (event.stepNumber === target.stepNumber || event.index === target.stepNumber - 1),
  )
) {
  events.push({ stepNumber: target.stepNumber, label: target.label, checkedAt: now });
}

const next = buildSignalUpdate(
  signal,
  terminalCommand ? { command: terminalCommand } : null,
  target,
  timing,
  events,
  now,
  taskPath,
  taskDir,
);
atomicWrite(signalPath, `${JSON.stringify(next, null, 2)}\n`, 0o644);

if (isStartCommand) {
  console.log('signal started');
} else if (terminalCommand) {
  console.log(
    `signal ${terminalCommand}: status=${next.status} disposition=${next.disposition ?? 'n/a'}`,
  );
} else {
  console.log(`marked ${target.stepNumber}: ${target.label}`);
}
