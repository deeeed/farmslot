#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  expandedArtifactsForCommand,
  resolveWorkerTerminalContract,
} = require('./worker-terminal-contract.cjs');

const START_COMMANDS = new Set(['start']);
const TERMINAL_COMMANDS = new Set(['complete', 'no-change', 'blocked']);
const NO_CHANGE_REPORT = path.join('artifacts', 'no-change-report.md');
const LEARNINGS_ARTIFACT = path.join('artifacts', 'learnings.md');
const ARTIFACT_CONTRACT_SCRIPT = path.resolve(__dirname, 'check-task-artifact-contract.mjs');

const FLOW_REPORT_ARTIFACTS = {
  'fix-bug': ['pr-description.md', 'report.md'],
  'review-pr': ['review.md', 'report.md'],
  dev: ['pr-description.md', 'report.md'],
  'pr-complete': ['comments-report.md', 'report.md'],
  'merge-main': ['report.md', 'merge-report.md'],
};
const FALLBACK_REPORT_ARTIFACTS = [
  'report.md',
  'review.md',
  'comments-report.md',
  'merge-report.md',
];

const usageLine =
  'usage: mark <step-number|start|complete|no-change|blocked> [--reason text] [--already-fixed] [--mark-last] [--no-self-review] [--skip-learnings] [--skip-checklist]';

function printHelp() {
  console.log(
    [
      usageLine,
      '',
      'Bootstrap: ./mark start — worker-owned SIGNAL.json with status running (no checklist box).',
      'Progress: ./mark 1, ./mark 2, ... — checks the box and appends checklistTiming.',
      'Terminal:',
      '  ./mark complete [--mark-last] [--no-self-review] [--skip-learnings] [--skip-checklist]',
      '  ./mark no-change --reason "..." [--already-fixed] [--mark-last] [--skip-learnings] [--skip-checklist]',
      '  ./mark blocked --reason "..." [--mark-last]',
      'Terminal success paths require non-empty artifacts/learnings.md and a flow outcome artifact (complete) or no-change-report (no-change).',
      'PR flows (dev, fix-bug): write artifacts/pr-description.md. Other flows: review.md, merge-report.md, report.md, etc.',
      'With --mark-last, every checklist box must be [x] unless --skip-checklist. complete also runs check-task-artifact-contract.mjs.',
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
  if (
    key === '--mark-last' ||
    key === '--already-fixed' ||
    key === '--no-self-review' ||
    key === '--skip-learnings' ||
    key === '--skip-checklist'
  ) {
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

function loadTerminalContract(taskDir, taskPath) {
  const contractPath = path.join(taskDir, 'inputs', 'worker-terminal-contract.json');
  if (fs.existsSync(contractPath)) {
    return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  }
  const flowType = inferFlowType(taskPath);
  return flowType ? resolveWorkerTerminalContract(null, flowType) : null;
}

function taskFileExists(taskDir, storedPath) {
  try {
    return fs.statSync(path.join(taskDir, storedPath)).isFile();
  } catch {
    return false;
  }
}

function assertArtifactFile(taskDir, storedPath) {
  const abs = path.join(taskDir, storedPath);
  if (!fs.existsSync(abs)) {
    console.error(`missing required artifact: ${storedPath}`);
    process.exit(1);
  }
  if (storedPath.endsWith('.md')) {
    const text = fs.readFileSync(abs, 'utf8').trim();
    if (!text) {
      console.error(`${storedPath} exists but is empty`);
      process.exit(1);
    }
  }
}

function assertRequiredArtifacts(taskDir, terminalCommand, contract) {
  if (!contract) return;
  const expanded = expandedArtifactsForCommand(contract, terminalCommand, (rel) =>
    taskFileExists(taskDir, rel),
  );
  for (const storedPath of expanded.artifacts) {
    if (storedPath === LEARNINGS_ARTIFACT && opts['skip-learnings']) continue;
    assertArtifactFile(taskDir, storedPath);
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

function assertLearningsArtifact(taskDir) {
  const learningsAbs = path.join(taskDir, LEARNINGS_ARTIFACT);
  if (!fs.existsSync(learningsAbs)) {
    console.error(`missing required artifact: ${LEARNINGS_ARTIFACT}`);
    process.exit(1);
  }
  const text = fs.readFileSync(learningsAbs, 'utf8').trim();
  if (!text) {
    console.error(`${LEARNINGS_ARTIFACT} exists but is empty — write at least one bullet`);
    process.exit(1);
  }
  return LEARNINGS_ARTIFACT;
}

function readArtifactText(taskDir, relativePath) {
  const artifactAbs = path.join(taskDir, 'artifacts', relativePath);
  if (!fs.existsSync(artifactAbs)) return null;
  const text = fs.readFileSync(artifactAbs, 'utf8').trim();
  return text || null;
}

function inferFlowType(taskPath) {
  let head = '';
  try {
    head = fs.readFileSync(taskPath, 'utf8').split('\n').slice(0, 24).join('\n');
  } catch {
    return null;
  }
  const workerMatch = head.match(/^#\s*Worker:\s*([^\n—-]+)/im);
  if (workerMatch) {
    const label = workerMatch[1].trim().toLowerCase();
    if (label.includes('fix-bug') || label.includes('fix bug')) return 'fix-bug';
    if (label.includes('review-pr') || label.includes('review pr')) return 'review-pr';
    if (label.includes('pr-complete') || label.includes('pr complete')) return 'pr-complete';
    if (label.includes('merge-main') || label.includes('merge main')) return 'merge-main';
    if (label.includes('interactive dev')) return 'dev';
    if (/\bdev\b/.test(label) && !label.includes('review')) return 'dev';
  }
  return null;
}

function assertWorkerReport(taskDir, taskPath) {
  const flowType = inferFlowType(taskPath);
  const candidates = flowType
    ? (FLOW_REPORT_ARTIFACTS[flowType] ?? FALLBACK_REPORT_ARTIFACTS)
    : FALLBACK_REPORT_ARTIFACTS;
  const found = candidates.find((name) => readArtifactText(taskDir, name));
  if (found) return `artifacts/${found}`;
  console.error(
    `missing required worker report — expected non-empty artifacts/{${candidates.join(', ')}}`,
  );
  process.exit(1);
  return null;
}

function assertChecklistComplete(taskPath, { allowOneUnchecked = false } = {}) {
  const parsed = parseChecklist(fs.readFileSync(taskPath, 'utf8'));
  const unchecked = parsed.items.filter((entry) => !entry.checked);
  if (unchecked.length === 0) return;
  if (allowOneUnchecked && unchecked.length === 1) return;
  const summary = unchecked
    .slice(0, 5)
    .map((entry) => `${entry.stepNumber}:${entry.label}`)
    .join('; ');
  console.error(
    `checklist incomplete — ${unchecked.length} step(s) still [ ] (${summary}${unchecked.length > 5 ? '; …' : ''})`,
  );
  process.exit(1);
}

function assertArtifactContract(taskDir, contract, terminalCommand) {
  if (!fs.existsSync(ARTIFACT_CONTRACT_SCRIPT)) {
    console.error(`missing artifact contract script: ${ARTIFACT_CONTRACT_SCRIPT}`);
    process.exit(1);
  }
  const contractPath = path.join(taskDir, 'inputs', 'worker-terminal-contract.json');
  const args = [ARTIFACT_CONTRACT_SCRIPT, taskDir];
  if (fs.existsSync(contractPath)) {
    args.push('--contract', contractPath);
    if (terminalCommand) args.push('--terminal', terminalCommand);
    if (opts['skip-learnings']) args.push('--skip-learnings');
  } else {
    if (!opts['skip-learnings']) args.push('--require-learnings');
    if (fs.existsSync(path.join(taskDir, 'artifacts', 'recipe.json'))) {
      args.push('--require-recipe-coverage-if-recipe', '--require-recipe-quality-if-recipe');
    }
  }
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.status ?? 1);
  }
}

function assertTerminalPackagedEvidence(taskPath, taskDir, terminalCommand) {
  if (terminalCommand === 'blocked') return;

  const contract = loadTerminalContract(taskDir, taskPath);
  if (contract) {
    assertRequiredArtifacts(taskDir, terminalCommand, contract);
    assertArtifactContract(taskDir, contract, terminalCommand);
    return;
  }

  if (terminalCommand === 'no-change') {
    assertNoChangeReport(taskDir);
  } else if (terminalCommand === 'complete') {
    assertWorkerReport(taskDir, taskPath);
  }

  if (!opts['skip-learnings']) {
    assertLearningsArtifact(taskDir);
  }

  if (terminalCommand === 'complete' || terminalCommand === 'no-change') {
    assertArtifactContract(taskDir);
  }
}

function buildSignalUpdate(signal, terminal, target, timing, events, now, taskPath, _taskDir) {
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

  const contract = terminal ? loadTerminalContract(_taskDir, taskPath) : null;
  if (terminal.command === 'no-change') {
    next.evidence = {
      reportPath: contract?.commands?.['no-change']?.report ?? NO_CHANGE_REPORT,
    };
  } else if (terminal.command === 'complete') {
    const reportPath = contract?.commands?.complete?.report;
    if (reportPath) next.evidence = { reportPath };
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
if (
  terminalCommand &&
  (terminalCommand === 'complete' || terminalCommand === 'no-change') &&
  opts['mark-last'] &&
  !opts['skip-checklist']
) {
  assertChecklistComplete(taskPath, { allowOneUnchecked: true });
}
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

if (terminalCommand) {
  assertTerminalPackagedEvidence(taskPath, taskDir, terminalCommand);
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
