#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  expandedArtifactsForCommand,
  resolveWorkerTerminalContract,
  resolveWorkerTerminalArtifactPath,
  deterministicChecks,
} = require('./worker-terminal-contract.cjs');
const {
  parseTaskDirMarkArgs,
  terminalContractInputForChecklist,
} = require('./checklist-target.cjs');
const {
  atomicWrite,
  markStepInLines,
  parseChecklist,
  pickSignalPassthrough,
  operatorWaitHistory,
  readJson,
  signalContentUnchanged,
  writeSignal,
} = require('./mark-io.cjs');
const { AcceptanceRefusal, requireHandoffAcceptanceCriteria } = require('./acceptance-ledger.cjs');
const {
  openSubtaskRefusal,
  openSubtaskUnits,
  runSubtaskCommand,
  subtaskOwningStep,
} = require('./subtask-unit.cjs');

const START_COMMANDS = new Set(['start']);
const OPERATOR_COMMANDS = new Set(['wait', 'resume']);
const TERMINAL_COMMANDS = new Set(['complete', 'no-change', 'blocked']);
const NO_CHANGE_REPORT = path.join('artifacts', 'no-change-report.md');
const LEARNINGS_ARTIFACT = path.join('artifacts', 'learnings.md');
const ARTIFACT_CONTRACT_SCRIPT = path.resolve(__dirname, 'check-task-artifact-contract.mjs');

const FLOW_REPORT_ARTIFACTS = {
  qa: ['report.html', 'qa-report.md', 'report.md'],
  'fix-bug': ['pr-description.md', 'report.md'],
  'review-pr': ['review.md', 'report.md'],
  dev: ['pr-description.md', 'report.md'],
  'pr-complete': ['comments-report.md', 'report.md'],
  'update-branch': ['branch-update-report.md', 'report.md'],
  'ci-fix': ['report.md'],
  review: ['review-feedback.md', 'report.md'],
  'review-fix': ['report.md'],
};
const FALLBACK_REPORT_ARTIFACTS = [
  'report.md',
  'review.md',
  'comments-report.md',
  'branch-update-report.md',
];

const usageLine =
  'usage: mark <task-dir> [--checklist FILE.md] [--signal FILE.json] <step> [options]';

function printHelp() {
  console.log(
    [
      usageLine,
      '',
      'Task-dir mode: farmslot-agent mark <task-dir> <step> — marks CHECKLIST.md (or TASK.md) unless checklist-target.json, written by a role switch, points elsewhere.',
      'Override: farmslot-agent mark <task-dir> --checklist REVIEW.md <step> — optional --signal; signal defaults from checklist name.',
      'Bootstrap: ./mark start — role-owned signal with status running (no checklist box).',
      'Progress: ./mark 1, ./mark 2, ... — checks the box and appends checklistTiming.',
      'Operator: ./mark wait --who "name" --reason "..."; ./mark resume clears the wait without marking a row.',
      'Child units: ./mark sub start <id> --step N --from <path|inline:text>, then ./mark sub <id> <n> | complete [--report PATH] [--mark-last] | blocked --reason "..." | status.',
      '  While a child owns step N, ./mark N is refused; the child complete ticks it. Run ./mark sub --help for the child verbs.',
      'Terminal:',
      '  ./mark complete [--mark-last] [--no-review] [--skip-learnings] [--skip-checklist]',
      '  ./mark no-change --reason "..." [--already-fixed] [--mark-last] [--skip-learnings] [--skip-checklist]',
      '  ./mark blocked --reason "..." [--mark-last]',
      'Terminal success paths require the flow contract artifacts: contribution flows need non-empty artifacts/learnings.md plus a flow outcome artifact (complete) or no-change-report (no-change); reviewer flows (review, review-fix) need their feedback/report artifact instead of learnings.',
      'PR flows (dev, fix-bug): write artifacts/pr-description.md. Other flows: review.md, review-feedback.md, branch-update-report.md, report.md, etc.',
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

function isMarkStepToken(token) {
  if (token === '--help' || token === '-h') return true;
  const lower = String(token).toLowerCase();
  if (START_COMMANDS.has(lower) || OPERATOR_COMMANDS.has(lower) || TERMINAL_COMMANDS.has(lower))
    return true;
  const stepNumber = Number(token);
  return Number.isInteger(stepNumber) && stepNumber >= 1;
}

function resolveMarkInvocation(rawArgs) {
  if (rawArgs.length === 0) usage();
  const first = rawArgs[0];
  if (first === '--help' || first === '-h') {
    printHelp();
    process.exit(0);
  }

  const firstPath = path.resolve(first);
  const firstIsDir = fs.existsSync(firstPath) && fs.statSync(firstPath).isDirectory();
  if (firstIsDir) {
    // Child-unit verbs own their own argument grammar (`sub start <id> …`), so
    // they are routed before the parent step parser sees a non-step token.
    if (rawArgs[1] === 'sub') {
      process.exit(runSubtaskCommand(firstPath, rawArgs.slice(2)));
    }
    const parsed = parseTaskDirMarkArgs(firstPath, rawArgs.slice(1), {
      isMarkStepToken,
      usage,
    });
    if (parsed.help) {
      printHelp();
      process.exit(0);
    }
    return parsed;
  }

  usage();
}

const args = process.argv.slice(2);
const { taskPath, signalPath, stepRaw, rest } = resolveMarkInvocation(args);

const opts = {};
for (let i = 0; i < rest.length; i += 1) {
  const key = rest[i];
  if (
    key === '--mark-last' ||
    key === '--already-fixed' ||
    key === '--no-review' ||
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
const isOperatorCommand = OPERATOR_COMMANDS.has(stepToken);
const terminalCommand = TERMINAL_COMMANDS.has(stepToken) ? stepToken : null;
let stepNumber = null;
if (!isStartCommand && !isOperatorCommand && !terminalCommand) {
  stepNumber = Number(stepRaw);
  if (!Number.isInteger(stepNumber) || stepNumber < 1) usage();
}

if (isStartCommand && Object.keys(opts).length > 0) usage();
if (stepToken === 'resume' && Object.keys(opts).length > 0) usage();
if (stepToken === 'wait') {
  if (
    Object.keys(opts).some((key) => !['who', 'reason'].includes(key)) ||
    !opts.who?.trim() ||
    opts.who.trim().length > 128 ||
    !opts.reason?.trim() ||
    opts.reason.trim().length > 2048
  ) {
    console.error('wait requires --who (1-128 characters) and --reason (1-2048 characters)');
    process.exit(1);
  }
}
if (terminalCommand === 'no-change' || terminalCommand === 'blocked') {
  if (!opts.reason?.trim()) {
    console.error(`${terminalCommand} requires --reason`);
    process.exit(1);
  }
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

function terminalContractPath(taskDir, taskPath) {
  const scopedPath = path.join(taskDir, terminalContractInputForChecklist(path.basename(taskPath)));
  if (fs.existsSync(scopedPath)) return scopedPath;
  return path.join(taskDir, 'inputs', 'worker-terminal-contract.json');
}

function loadTerminalContract(taskDir, taskPath) {
  const contractPath = terminalContractPath(taskDir, taskPath);
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
    assertArtifactFile(
      taskDir,
      resolveWorkerTerminalArtifactPath(
        taskDir,
        storedPath,
        contract.recordedEvidenceContractVersion ?? 0,
      ),
    );
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
  const workerMatch = head.match(/^#\s*Worker:\s*([^\n]+)/im);
  if (workerMatch) {
    const label = workerMatch[1]
      .split(/\s+[—-]\s+/)[0]
      .trim()
      .toLowerCase();
    if (label.includes('fix-bug') || label.includes('fix bug')) return 'fix-bug';
    if (label.includes('review-pr') || label.includes('review pr')) return 'review-pr';
    if (label.includes('pr-complete') || label.includes('pr complete')) return 'pr-complete';
    if (label.includes('update-branch') || label.includes('update branch')) return 'update-branch';
    if (label.includes('ci-fix') || label.includes('ci fix')) return 'ci-fix';
    if (label.includes('review fix') || label.includes('review-fix')) return 'review-fix';
    if (label.includes('review')) return 'review';
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

function assertArtifactContract(taskDir, taskPath, contract, terminalCommand) {
  if (!fs.existsSync(ARTIFACT_CONTRACT_SCRIPT)) {
    console.error(`missing artifact contract script: ${ARTIFACT_CONTRACT_SCRIPT}`);
    process.exit(1);
  }
  const contractPath = terminalContractPath(taskDir, taskPath);
  const args = [ARTIFACT_CONTRACT_SCRIPT, taskDir];
  if (terminalCommand) args.push('--terminal', terminalCommand);
  // This explicit flag keeps project opt-ins compatible with older checkers.
  // Current checkers also enforce registered verdicts on terminal complete.
  if (terminalCommand === 'complete' && contract?.acceptance?.require === true) {
    let criteria;
    try {
      criteria = requireHandoffAcceptanceCriteria(taskDir);
    } catch (err) {
      // Fail closed, the same way the gateway's backup check does: a handoff the
      // engine cannot read hides whether the criteria were judged, and dropping
      // the rule the project asked for is how an unproven run closes.
      if (!(err instanceof AcceptanceRefusal)) throw err;
      console.error(err.message);
      process.exit(1);
    }
    if (criteria.length > 0) args.push('--require-acceptance-status');
  }
  if (fs.existsSync(contractPath)) {
    args.push('--contract', contractPath);
    if (opts['skip-learnings']) args.push('--skip-learnings');
  } else {
    // No persisted contract file — honor the resolved builtin contract instead of
    // assuming learnings: reviewer flows (review, review-fix) require their
    // feedback/report artifact, not artifacts/learnings.md.
    const contractRequiresLearnings = contract
      ? (contract.commands?.[terminalCommand ?? 'complete']?.artifacts ?? []).includes(
          LEARNINGS_ARTIFACT.split(path.sep).join('/'),
        )
      : true;
    if (!opts['skip-learnings'] && contractRequiresLearnings) args.push('--require-learnings');
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
    assertArtifactContract(taskDir, taskPath, contract, terminalCommand);
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
    assertArtifactContract(taskDir, taskPath, undefined, terminalCommand);
  }
}

function buildSignalUpdate(signal, terminal, target, timing, events, now, taskPath, _taskDir) {
  const sameAttempt =
    !isStartCommand ||
    (signal.waitingForOperator && !process.env.FARMSLOT_SIGNAL_ATTEMPT_ID) ||
    (process.env.FARMSLOT_SIGNAL_ATTEMPT_ID &&
      signal.attemptId === process.env.FARMSLOT_SIGNAL_ATTEMPT_ID);
  const base = {
    ...pickSignalPassthrough(signal),
    ...(isStartCommand && !sameAttempt
      ? { attemptId: process.env.FARMSLOT_SIGNAL_ATTEMPT_ID || randomUUID() }
      : {}),
    step: target?.label ?? signal.step ?? 'complete',
    checklistTiming: {
      schemaVersion: 1,
      source: timing.source || path.basename(taskPath),
      events,
    },
    timestamp: now,
    ...operatorWaitHistory(signal, now, { reset: !sameAttempt, closeWait: stepToken !== 'wait' }),
    ...(stepToken === 'wait'
      ? {
          waitingForOperator: {
            who: opts.who.trim(),
            reason: opts.reason.trim(),
            since: signal.waitingForOperator?.since ?? now,
          },
        }
      : {}),
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
    ...(terminal.command === 'complete' && opts['no-review'] ? { needsReview: false } : {}),
    ...(opts['skip-learnings'] ? { artifactWaivers: { learnings: true } } : {}),
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
    // Also covers `--mark-last`: the parent must not tick a box whose child is
    // still open, whichever way the row was chosen.
    assertStepNotOwnedBySubtask(item.stepNumber);
    try {
      deterministicChecks.execute(path.dirname(taskPath), path.basename(taskPath), item.stepNumber);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
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

/**
 * A step owned by a child unit belongs to that child until it is settled
 * (`complete` or `done` — a `blocked` child keeps ownership). The child's
 * `complete` ticks the box, so a later `mark N` on it is an idempotent no-op.
 */
function assertStepNotOwnedBySubtask(stepNumber) {
  if (stepNumber == null) return;
  const owner = subtaskOwningStep(taskDir, path.basename(taskPath), stepNumber);
  if (!owner) return;
  const open = openSubtaskUnits(taskDir).find((entry) => entry.unit.id === owner.id);
  if (!open) return;
  console.error(
    `step ${stepNumber} is owned by subtask ${owner.id}; finish it with ./mark sub ${owner.id} complete`,
  );
  process.exit(1);
}

/** Every registered child must be settled before the parent reports success. */
function assertNoOpenSubtasks(command) {
  const open = openSubtaskUnits(taskDir);
  if (open.length === 0) return;
  console.error(openSubtaskRefusal(open, command));
  process.exit(1);
}

// `blocked` stays available while a child is open: the run is blocked either way.
if (terminalCommand === 'complete' || terminalCommand === 'no-change') {
  assertNoOpenSubtasks(terminalCommand);
}
if (
  terminalCommand &&
  (terminalCommand === 'complete' || terminalCommand === 'no-change') &&
  opts['mark-last'] &&
  !opts['skip-checklist']
) {
  assertChecklistComplete(taskPath, { allowOneUnchecked: true });
}
// A successful verdict (no-change writes `complete` too) stays put: `./mark N` on
// a declared deterministic step reruns its check so the receipt matches the
// current tree, and leaves the box and the signal as they are.
if (stepNumber != null && readJson(signalPath).status === 'complete') {
  try {
    if (deterministicChecks.execute(taskDir, path.basename(taskPath), stepNumber)) {
      console.log(
        `signal already terminal: status=complete; refreshed the receipt of deterministic step ${stepNumber} for the current tree`,
      );
      process.exit(0);
    }
  } catch (error) {
    console.error(`signal already terminal: status=complete; ${error.message}`);
    process.exit(1);
  }
}
const target =
  isStartCommand || isOperatorCommand
    ? { stepNumber: null, label: 'started' }
    : resolveTarget(taskPath, stepNumber, Boolean(terminalCommand && opts['mark-last']));

const now = new Date().toISOString();
const signal = readJson(signalPath);
if (isOperatorCommand && (signal.status !== 'running' || !signal.attemptId)) {
  console.error(`${stepToken} requires an active signal; use ./mark start first`);
  process.exit(1);
}
if (
  isOperatorCommand &&
  process.env.FARMSLOT_SIGNAL_ATTEMPT_ID &&
  signal.attemptId !== process.env.FARMSLOT_SIGNAL_ATTEMPT_ID
) {
  console.error('operator mark belongs to a different worker attempt');
  process.exit(1);
}
if (stepToken === 'resume' && !signal.waitingForOperator) {
  console.log('signal is already resumed');
  process.exit(0);
}
if (isOperatorCommand || (isStartCommand && signal.waitingForOperator))
  target.label = signal.step ?? 'started';
// The launcher owns the attempt. Descendants may repeat bootstrap, but must not
// replace the parent's identity or reset progress within that same attempt.
if (
  isStartCommand &&
  process.env.FARMSLOT_SIGNAL_ATTEMPT_ID &&
  signal.attemptId === process.env.FARMSLOT_SIGNAL_ATTEMPT_ID &&
  signal.status === 'running' &&
  !signal.waitingForOperator
) {
  console.log('signal already started');
  process.exit(0);
}
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
// Re-marking a step that is already done changes nothing: the box was checked
// and its timing event already exists, so the only difference from the stored
// signal would be a fresh `timestamp`. Compare content, never the command: that
// keeps `start` (new attemptId), a terminal mark (new status), a resume from
// `blocked`, and a box checked by hand without an event all writing as before,
// while a genuinely empty re-mark stays a no-op.
const alreadyRecorded = !isStartCommand && !terminalCommand && signalContentUnchanged(signal, next);

if (alreadyRecorded) {
  console.log(`already marked ${target.stepNumber}: ${target.label}`);
} else {
  // One signal writer for the parent and child paths, so their bytes and mode
  // cannot drift (mark-io.cjs writeSignal).
  writeSignal(signalPath, next);
  if (isStartCommand) {
    console.log('signal started');
  } else if (terminalCommand) {
    console.log(
      `signal ${terminalCommand}: status=${next.status} disposition=${next.disposition ?? 'n/a'}`,
    );
  } else {
    console.log(`marked ${target.stepNumber}: ${target.label}`);
  }
}
