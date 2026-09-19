const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  checklistNumberingMismatches,
  checklistStepName,
  enumerateChecklistCheckboxes,
  isSettledSubtaskStatus,
  resolveChecklistTargetWithOverrides,
  SUBTASK_ID_PATTERN,
  SUBTASK_INDEX_FILE,
  SUBTASKS_DIR,
  subtaskPaths,
  targetForChecklistBasename,
} = require('./checklist-target.cjs');
const {
  atomicWrite,
  markStepInFile,
  parseChecklist,
  pickSignalPassthrough,
  readJson,
  writeSignal,
} = require('./mark-io.cjs');

// Child checklist units (ADR-060 / plans/sub-task-observability-v1.md).
//
// `mark` is the only writer of `subtasks/`: it materializes a child checklist
// from a source, registers it in `subtasks/index.json`, and maintains the child
// signal plus the parent signal effects. Farmslot never spawns the child; a
// child unit is files and signals only.
//
// A child unit is NOT a role switch: it never writes `checklist-target.json` and
// never changes the run's active task file.

const HANDOFF_INPUT = path.join('inputs', 'handoff.json');
const SUBTASK_INDEX_REL = `${SUBTASKS_DIR}/${SUBTASK_INDEX_FILE}`;

/** A refused command: the message is worker-facing, the code is the exit code. */
class SubtaskRefusal extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'SubtaskRefusal';
    this.code = code;
  }
}

function usageRefusal(message) {
  return new SubtaskRefusal(message, 2);
}

const SUB_USAGE = [
  'usage: mark <task-dir> sub <command>',
  '',
  '  sub start <id> --step N --from <path|template:<id>|inline:<text>> [--var K=V ...] [--checklist FILE.md]',
  '      register one child unit on parent step N: writes subtasks/<id>.md,',
  '      subtasks/index.json and subtasks/<id>-SIGNAL.json.',
  '  sub <id> <n>                      tick child box n (child status running)',
  '  sub <id> complete [--report PATH] [--mark-last]',
  '                                    finish the child, tick the parent box',
  '  sub <id> blocked --reason "..."   block the child and the parent signal',
  '  sub <id> status                   print the child projection as JSON',
  '',
  'A child unit has no flow terminal contract; --report is its only artifact rule.',
  'Placeholders in --from are rendered with the task vars from inputs/handoff.json',
  '(TASK_DIR, FLOW, PROJECT, DOMAIN, GH_REPO, TITLE, TICKET, TEMPLATE) plus --var.',
].join('\n');

function printSubtaskHelp() {
  console.log(SUB_USAGE);
}

// ---------------------------------------------------------------------------
// index

function subtaskIndexPath(taskDir) {
  return path.join(taskDir, SUBTASKS_DIR, SUBTASK_INDEX_FILE);
}

/** The registry, or null when this task dir has no child unit. Throws on a corrupt file. */
function readSubtaskIndex(taskDir) {
  const file = subtaskIndexPath(taskDir);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.units)
  ) {
    throw new SubtaskRefusal(
      `invalid ${SUBTASK_INDEX_REL}: expected { "schemaVersion": 1, "units": [] } — only mark writes this file`,
    );
  }
  return parsed;
}

function writeSubtaskIndex(taskDir, index) {
  atomicWrite(subtaskIndexPath(taskDir), `${JSON.stringify(index, null, 2)}\n`);
}

function unitById(index, id) {
  return index?.units.find((unit) => unit.id === id) ?? null;
}

/** The child unit registered on a parent step, whatever its status. */
function subtaskOwningStep(taskDir, parentChecklistBasename, stepNumber) {
  const index = readSubtaskIndex(taskDir);
  if (!index) return null;
  return (
    index.units.find(
      (unit) =>
        unit.parent?.checklist === parentChecklistBasename &&
        unit.parent?.stepNumber === stepNumber,
    ) ?? null
  );
}

function childStatus(taskDir, unit) {
  const signal = readJson(path.join(taskDir, unit.signal));
  return typeof signal.status === 'string' ? signal.status : null;
}

/**
 * Registered units that have not finished. Settled means `complete` or `done`;
 * a `blocked` child is still open and still owns its parent step.
 */
function openSubtaskUnits(taskDir) {
  const index = readSubtaskIndex(taskDir);
  if (!index) return [];
  return index.units
    .map((unit) => ({ unit, status: childStatus(taskDir, unit) }))
    .filter((entry) => !isSettledSubtaskStatus(entry.status));
}

function openSubtaskRefusal(open, terminalCommand) {
  const detail = open
    .map((entry) => `${entry.unit.id} (${entry.status ?? 'no signal'})`)
    .join(', ');
  const finish = open.map((entry) => `./mark sub ${entry.unit.id} complete`).join(' && ');
  return `cannot ${terminalCommand} while a subtask is open: ${detail}; finish it with ${finish}`;
}

// ---------------------------------------------------------------------------
// materialization

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Body of a markdown document, YAML frontmatter removed. Behavioural mirror of
 * `parseMarkdownDocument` in src/execution-template/frontmatter.ts: the closing
 * fence must be exactly `---` on its own line, and an unterminated block is
 * content (see test/subtask-render-parity.test.ts).
 */
function stripMarkdownFrontmatter(text) {
  const normalized = String(text).replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) return normalized;
  let end = -1;
  for (let from = 3; ; ) {
    const candidate = normalized.indexOf('\n---', from);
    if (candidate === -1) break;
    const after = normalized.slice(candidate + 4, candidate + 6);
    if (after === '' || after.startsWith('\n') || after === '\r\n' || after.startsWith('\r\n')) {
      end = candidate;
      break;
    }
    from = candidate + 1;
  }
  if (end === -1) return normalized;
  return normalized.slice(end + '\n---'.length).replace(/^\r?\n/, '');
}

const PLACEHOLDER_TOKEN_RE = /\{\{[^{}\n]+\}\}/g;

/**
 * Substitute `{{KEY}}` after the same guard the task writer applies.
 * Behavioural mirror of `renderTemplatePlaceholders` /
 * `assertNoUnknownPlaceholders` in @farmslot/protocol (see
 * test/subtask-render-parity.test.ts): an unexpandable token is a refusal, never
 * a silently rendered `{{TOKEN}}` in the child checklist.
 */
function renderPlaceholders(template, vars, source) {
  const known = new Set(Object.keys(vars));
  const unknown = [
    ...new Set(Array.from(template.matchAll(PLACEHOLDER_TOKEN_RE), (m) => m[0])),
  ].filter((token) => {
    const name = token.slice(2, -2);
    return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !known.has(name);
  });
  if (unknown.length > 0) {
    throw new Error(
      `${source} references placeholder(s) with no expansion value: ${unknown.join(', ')} — ` +
        `supply the variable or remove the placeholder from the template`,
    );
  }
  let content = template;
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}

/** Task vars a child source may reference, from the handoff plus explicit --var. */
function taskVars(taskDir, extra) {
  const handoff = readJson(path.join(taskDir, HANDOFF_INPUT));
  const vars = { TASK_DIR: taskDir };
  const text = (value) => (typeof value === 'string' && value.trim() ? value : null);
  const task = handoff.task && typeof handoff.task === 'object' ? handoff.task : {};
  const assign = (key, value) => {
    if (value !== null) vars[key] = value;
  };
  assign('FLOW', text(handoff.flow));
  assign('PROJECT', text(handoff.project));
  assign('DOMAIN', text(handoff.domain));
  assign('GH_REPO', text(handoff.repo));
  assign('TITLE', text(task.title));
  assign('TICKET', text(task.ticket));
  assign('TEMPLATE', text(handoff.executionTemplate?.id));
  return { ...vars, ...extra };
}

/**
 * Source markdown for a child unit. `template:<id>` is refused: resolving a
 * catalog id needs the project's configured template sources, which `mark` (a
 * task-dir-local engine) cannot reach — materialize it first instead of
 * guessing a root.
 */
function readSubtaskSource(spec, taskDir) {
  if (typeof spec !== 'string' || !spec.trim()) {
    throw usageRefusal('sub start requires --from <path|template:<id>|inline:<text>>');
  }
  if (spec.startsWith('inline:')) {
    const text = spec.slice('inline:'.length);
    if (!text.trim()) throw new SubtaskRefusal('--from inline: requires checklist text');
    return { kind: 'inline', text };
  }
  if (spec.startsWith('template:')) {
    const id = spec.slice('template:'.length);
    throw new SubtaskRefusal(
      `--from template:${id} is not supported by mark: resolving a catalog id needs the project's ` +
        `execution-template sources, which the task-dir mark engine cannot read. Materialize it first ` +
        `(farmslot-agent execution-template materialize --id ${id} --out <path>) and pass --from <path>, ` +
        `or use --from inline:<text>.`,
    );
  }
  const candidates = path.isAbsolute(spec)
    ? [spec]
    : [path.resolve(process.cwd(), spec), path.resolve(taskDir, spec)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { kind: 'skill', ref: spec, text: fs.readFileSync(candidate, 'utf8') };
    }
  }
  throw new SubtaskRefusal(`--from source not found: tried ${candidates.join(', ')}`);
}

// ---------------------------------------------------------------------------
// signals

function timingOf(signal, source) {
  const timing =
    signal.checklistTiming && typeof signal.checklistTiming === 'object'
      ? signal.checklistTiming
      : { schemaVersion: 1, source, events: [] };
  const events = Array.isArray(timing.events) ? [...timing.events] : [];
  return { source: timing.source || source, events };
}

function appendTimingEvent(events, stepNumber, label, now) {
  if (stepNumber == null) return events;
  const seen = events.some(
    (event) => event && (event.stepNumber === stepNumber || event.index === stepNumber - 1),
  );
  if (seen) return events;
  return [...events, { stepNumber, label, checkedAt: now }];
}

/**
 * The parent-signal effect of a child command. Shape-identical to a parent
 * `mark` write (same passthrough keys, same `checklistTiming`), so nothing
 * downstream can tell a child-driven parent mark from a hand-run one.
 */
function writeParentSignal(taskDir, unit, { status, stepLabel, reason, event, now }) {
  const target = targetForChecklistBasename(unit.parent.checklist);
  const signalPath = path.join(taskDir, target.signal);
  const signal = readJson(signalPath);
  const timing = timingOf(signal, unit.parent.checklist);
  const events = event
    ? appendTimingEvent(timing.events, event.stepNumber, event.label, now)
    : timing.events;
  const next = {
    ...pickSignalPassthrough(signal),
    status,
    ...(status === 'blocked' ? { outcome: 'partial', disposition: 'blocked' } : {}),
    ...(reason ? { reason } : {}),
    step: stepLabel,
    checklistTiming: { schemaVersion: 1, source: timing.source, events },
    timestamp: now,
  };
  writeSignal(signalPath, next);
  return next;
}

function writeChildSignal(
  taskDir,
  unit,
  { status, stepLabel, reason, outcome, disposition, events, reportPath, now },
) {
  const signalPath = path.join(taskDir, unit.signal);
  const signal = readJson(signalPath);
  const next = {
    role: 'subtask',
    contextId: unit.id,
    ...(signal.attemptId !== undefined ? { attemptId: signal.attemptId } : {}),
    parent: unit.parent,
    status,
    ...(outcome ? { outcome } : {}),
    ...(disposition ? { disposition } : {}),
    ...(reason ? { reason } : {}),
    ...(reportPath ? { evidence: { reportPath } } : {}),
    step: stepLabel,
    checklistTiming: { schemaVersion: 1, source: unit.checklist, events },
    timestamp: now,
  };
  writeSignal(signalPath, next);
  return next;
}

// ---------------------------------------------------------------------------
// projection

/** The child projection `sub status` prints and the gateway mirrors in Phase 2. */
function subtaskProjection(taskDir, unit) {
  const checklistPath = path.join(taskDir, unit.checklist);
  const items = fs.existsSync(checklistPath)
    ? enumerateChecklistCheckboxes(fs.readFileSync(checklistPath, 'utf8'))
    : [];
  const signal = readJson(path.join(taskDir, unit.signal));
  const timing = signal.checklistTiming;
  const events = Array.isArray(timing?.events) ? timing.events : [];
  const status = typeof signal.status === 'string' ? signal.status : null;
  const open = items.find((item) => !item.checked) ?? null;
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  return {
    id: unit.id,
    status,
    settled: isSettledSubtaskStatus(status),
    parent: unit.parent,
    completedSteps: items.filter((item) => item.checked).length,
    totalSteps: items.length,
    currentStep: open ? checklistStepName(open.rawLabel) : null,
    lastEventAt: lastEvent?.checkedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// verbs

function parsedChecklistFile(taskDir, relativePath) {
  const absolute = path.join(taskDir, relativePath);
  if (!fs.existsSync(absolute)) {
    throw new SubtaskRefusal(`missing checklist: ${relativePath}`);
  }
  return { absolute, ...parseChecklist(fs.readFileSync(absolute, 'utf8')) };
}

function parseStepNumber(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw usageRefusal(`${label} must be a positive integer (got ${raw})`);
  }
  return value;
}

function parseFlags(rest, allowed, label) {
  const flags = { vars: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (key === '--mark-last') {
      if (!allowed.includes(key)) throw usageRefusal(`${label} does not accept ${key}`);
      flags['mark-last'] = true;
      continue;
    }
    if (!allowed.includes(key)) throw usageRefusal(`${label} does not accept ${key}`);
    const value = rest[i + 1];
    if (value === undefined) throw usageRefusal(`${key} requires a value`);
    i += 1;
    if (key === '--var') {
      const eq = value.indexOf('=');
      if (eq <= 0) throw usageRefusal('--var must use KEY=VALUE');
      flags.vars[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}

function subStart(taskDir, rest) {
  const id = rest[0];
  if (!id || id.startsWith('-')) throw usageRefusal('sub start requires <id>');
  if (!SUBTASK_ID_PATTERN.test(id)) {
    throw new SubtaskRefusal(
      `invalid subtask id '${id}': use a slug matching ${SUBTASK_ID_PATTERN}`,
    );
  }
  const flags = parseFlags(
    rest.slice(1),
    ['--step', '--from', '--var', '--checklist', '--signal'],
    'sub start',
  );
  if (!flags.step) throw usageRefusal('sub start requires --step N');
  const stepNumber = parseStepNumber(flags.step, '--step');

  const target = resolveChecklistTargetWithOverrides(taskDir, {
    ...(flags.checklist ? { checklist: flags.checklist } : {}),
    ...(flags.signal ? { signal: flags.signal } : {}),
  });
  const parent = parsedChecklistFile(taskDir, target.checklist);
  const parentRow = parent.items.find((item) => item.stepNumber === stepNumber) ?? null;
  if (!parentRow) {
    throw new SubtaskRefusal(`checklist step ${stepNumber} not found in ${target.checklist}`);
  }

  const index = readSubtaskIndex(taskDir) ?? { schemaVersion: 1, units: [] };
  // One child per step for the LIFE of the task directory: a settled child has
  // already ticked the box, so a second registration would reopen finished work.
  const owner = index.units.find(
    (unit) => unit.parent?.checklist === target.checklist && unit.parent?.stepNumber === stepNumber,
  );
  if (owner) {
    throw new SubtaskRefusal(`step ${stepNumber} already owned by subtask ${owner.id}`);
  }
  if (unitById(index, id)) {
    throw new SubtaskRefusal(`subtask ${id} already exists; one id per task directory`);
  }
  if (parentRow.checked) {
    throw new SubtaskRefusal(
      `step ${stepNumber} is already checked; a subtask cannot be registered on a completed step`,
    );
  }

  const source = readSubtaskSource(flags.from, taskDir);
  const body = stripMarkdownFrontmatter(source.text);
  const label = `Subtask ${id} source ${source.ref ?? '(inline)'}`;
  let rendered;
  try {
    rendered = renderPlaceholders(body, taskVars(taskDir, flags.vars), label);
  } catch (err) {
    throw new SubtaskRefusal(err instanceof Error ? err.message : String(err));
  }
  if (!rendered.endsWith('\n')) rendered += '\n';

  const childItems = enumerateChecklistCheckboxes(rendered);
  if (childItems.length === 0) {
    throw new SubtaskRefusal(
      `a child unit must have at least one step — ${label} has no enumerable checkbox ` +
        `(section headings matching the informational skip list are not counted)`,
    );
  }
  const mismatches = checklistNumberingMismatches(rendered);
  if (mismatches.length > 0) {
    throw new SubtaskRefusal(
      `${label} has checklist numbering that does not match step positions:\n` +
        mismatches.map((line) => `- ${line}`).join('\n'),
    );
  }

  const paths = subtaskPaths(id);
  const now = new Date().toISOString();
  const unit = {
    id,
    parent: { checklist: target.checklist, stepNumber },
    checklist: paths.checklist,
    signal: paths.signal,
    source: {
      kind: source.kind,
      ...(source.ref ? { ref: source.ref } : {}),
      sha256: sha256Text(source.text),
      renderedSha256: sha256Text(rendered),
    },
    registeredAt: now,
  };

  atomicWrite(path.join(taskDir, paths.checklist), rendered);
  writeSubtaskIndex(taskDir, { schemaVersion: 1, units: [...index.units, unit] });
  const parentSignal = readJson(path.join(taskDir, target.signal));
  writeSignal(path.join(taskDir, paths.signal), {
    role: 'subtask',
    contextId: id,
    // Share the parent's attempt so every signal of one attempt correlates;
    // contextId tells them apart.
    ...(parentSignal.attemptId !== undefined ? { attemptId: parentSignal.attemptId } : {}),
    parent: unit.parent,
    status: 'running',
    checklistTiming: { schemaVersion: 1, source: paths.checklist, events: [] },
    timestamp: now,
  });

  console.log(
    `subtask ${id} registered on ${target.checklist} step ${stepNumber}: ${paths.checklist} (${childItems.length} step(s))`,
  );
  return 0;
}

function subStep(taskDir, unit, rawStep) {
  const stepNumber = parseStepNumber(rawStep, 'subtask step');
  const child = parsedChecklistFile(taskDir, unit.checklist);
  const row = child.items.find((item) => item.stepNumber === stepNumber) ?? null;
  if (!row) {
    throw new SubtaskRefusal(`subtask ${unit.id} has no step ${stepNumber} in ${unit.checklist}`);
  }
  markStepInFile(child.absolute, row);

  const now = new Date().toISOString();
  const signal = readJson(path.join(taskDir, unit.signal));
  const timing = timingOf(signal, unit.checklist);
  writeChildSignal(taskDir, unit, {
    status: 'running',
    stepLabel: row.label,
    events: appendTimingEvent(timing.events, row.stepNumber, row.label, now),
    now,
  });
  resumeParentSignal(taskDir, unit, now);
  console.log(`marked subtask ${unit.id} ${stepNumber}: ${row.label}`);
  return 0;
}

/**
 * A child `blocked` blocked the parent signal too; resuming the child restores
 * `running` on both. Any other parent status is left alone: the parent is the
 * worker's own signal and a child step is not a parent mark.
 */
function resumeParentSignal(taskDir, unit, now) {
  const target = targetForChecklistBasename(unit.parent.checklist);
  const parentSignal = readJson(path.join(taskDir, target.signal));
  if (parentSignal.status !== 'blocked') return;
  const parent = parsedChecklistFile(taskDir, unit.parent.checklist);
  const parentRow = parent.items.find((item) => item.stepNumber === unit.parent.stepNumber) ?? null;
  writeParentSignal(taskDir, unit, {
    status: 'running',
    stepLabel: parentRow?.label ?? parentSignal.step ?? 'running',
    now,
  });
}

function subComplete(taskDir, unit, rest) {
  const flags = parseFlags(rest, ['--report', '--mark-last'], 'sub complete');
  if (flags.report !== undefined) {
    const reportAbs = path.join(taskDir, flags.report);
    if (!fs.existsSync(reportAbs) || !fs.statSync(reportAbs).isFile()) {
      throw new SubtaskRefusal(`missing required artifact: ${flags.report}`);
    }
    if (!fs.readFileSync(reportAbs, 'utf8').trim()) {
      throw new SubtaskRefusal(`${flags.report} exists but is empty`);
    }
  }

  const child = parsedChecklistFile(taskDir, unit.checklist);
  const unchecked = child.items.filter((item) => !item.checked);
  const allowOneUnchecked = Boolean(flags['mark-last']);
  if (unchecked.length > (allowOneUnchecked ? 1 : 0)) {
    const summary = unchecked
      .slice(0, 5)
      .map((entry) => `${entry.stepNumber}:${entry.label}`)
      .join('; ');
    throw new SubtaskRefusal(
      `subtask ${unit.id} checklist incomplete — ${unchecked.length} step(s) still [ ] ` +
        `(${summary}${unchecked.length > 5 ? '; …' : ''})` +
        (allowOneUnchecked ? '' : ' — mark them, or pass --mark-last for the final box'),
    );
  }
  const lastRow =
    allowOneUnchecked && unchecked.length === 1 ? unchecked[unchecked.length - 1] : null;
  if (lastRow) markStepInFile(child.absolute, lastRow);

  const now = new Date().toISOString();
  const signal = readJson(path.join(taskDir, unit.signal));
  const timing = timingOf(signal, unit.checklist);
  const events = lastRow
    ? appendTimingEvent(timing.events, lastRow.stepNumber, lastRow.label, now)
    : timing.events;
  // No flow terminal contract for a child unit: no inferFlowType, no
  // terminalContractInputForChecklist, no check-task-artifact-contract.mjs.
  writeChildSignal(taskDir, unit, {
    status: 'complete',
    outcome: 'success',
    disposition: 'fixed',
    stepLabel: lastRow?.label ?? signal.step ?? 'complete',
    ...(flags.report ? { reportPath: flags.report } : {}),
    events,
    now,
  });

  const parent = parsedChecklistFile(taskDir, unit.parent.checklist);
  const parentRow = parent.items.find((item) => item.stepNumber === unit.parent.stepNumber) ?? null;
  if (!parentRow) {
    throw new SubtaskRefusal(
      `parent step ${unit.parent.stepNumber} is no longer in ${unit.parent.checklist}; the checklist changed under the subtask`,
    );
  }
  markStepInFile(parent.absolute, parentRow);
  writeParentSignal(taskDir, unit, {
    status: 'running',
    stepLabel: parentRow.label,
    event: { stepNumber: parentRow.stepNumber, label: parentRow.label },
    now,
  });

  console.log(
    `subtask ${unit.id} complete: ticked ${unit.parent.checklist} step ${parentRow.stepNumber} (${parentRow.label})`,
  );
  return 0;
}

function subBlocked(taskDir, unit, rest) {
  const flags = parseFlags(rest, ['--reason'], 'sub blocked');
  const reason = flags.reason?.trim();
  if (!reason) throw usageRefusal('sub blocked requires --reason');

  const child = parsedChecklistFile(taskDir, unit.checklist);
  const signal = readJson(path.join(taskDir, unit.signal));
  const timing = timingOf(signal, unit.checklist);
  const open = child.items.find((item) => !item.checked) ?? null;
  const now = new Date().toISOString();
  // A child signal never carries `failed`: work that cannot finish is blocked
  // with a reason, and the operator uses the existing blocked-run actions.
  writeChildSignal(taskDir, unit, {
    status: 'blocked',
    outcome: 'partial',
    disposition: 'blocked',
    reason,
    stepLabel: signal.step ?? open?.label ?? 'blocked',
    events: timing.events,
    now,
  });

  const parent = parsedChecklistFile(taskDir, unit.parent.checklist);
  const parentRow = parent.items.find((item) => item.stepNumber === unit.parent.stepNumber) ?? null;
  writeParentSignal(taskDir, unit, {
    status: 'blocked',
    stepLabel: parentRow?.label ?? `step ${unit.parent.stepNumber}`,
    reason: `subtask ${unit.id}: ${reason}`,
    now,
  });

  console.log(`subtask ${unit.id} blocked: ${reason}`);
  return 0;
}

function subStatus(taskDir, unit) {
  console.log(JSON.stringify(subtaskProjection(taskDir, unit), null, 2));
  return 0;
}

/** `mark <task-dir> sub …`. Returns the process exit code; never throws. */
function runSubtaskCommand(taskDirRaw, args) {
  const taskDir = path.resolve(taskDirRaw);
  try {
    if (args.length === 0) throw usageRefusal(SUB_USAGE);
    if (args[0] === '--help' || args[0] === '-h') {
      printSubtaskHelp();
      return 0;
    }
    if (args[0] === 'start') return subStart(taskDir, args.slice(1));

    const id = args[0];
    const verb = args[1];
    if (verb === undefined) throw usageRefusal(SUB_USAGE);
    const index = readSubtaskIndex(taskDir);
    const unit = unitById(index, id);
    if (!unit) {
      const known = (index?.units ?? []).map((entry) => entry.id);
      throw new SubtaskRefusal(
        `unknown subtask ${id}${known.length ? ` (registered: ${known.join(', ')})` : ''}; ` +
          `register it with ./mark sub start ${id} --step N --from <source>`,
      );
    }
    if (verb === 'complete') return subComplete(taskDir, unit, args.slice(2));
    if (verb === 'blocked') return subBlocked(taskDir, unit, args.slice(2));
    if (verb === 'status') return subStatus(taskDir, unit);
    return subStep(taskDir, unit, verb);
  } catch (err) {
    if (err instanceof SubtaskRefusal) {
      console.error(err.message);
      return err.code;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

module.exports = {
  SUBTASK_INDEX_REL,
  SubtaskRefusal,
  openSubtaskRefusal,
  openSubtaskUnits,
  readSubtaskIndex,
  renderPlaceholders,
  runSubtaskCommand,
  stripMarkdownFrontmatter,
  subtaskIndexPath,
  subtaskOwningStep,
  subtaskProjection,
  taskVars,
};
