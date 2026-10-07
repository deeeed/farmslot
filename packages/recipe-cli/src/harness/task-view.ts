// Read-only view of the task an agent is working through in a checkout. A hand
// run started from a skill and a dispatched run write the same files, so both
// report the same facts here.
//
// Every value comes from a fixed allowlist. Anything else those files carry —
// secrets included — can never reach the view model or the rendered output.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { HANDOFF_INPUT, latestTaskDir } from '@farmslot/agent-runtime';
import {
  checklistStepName,
  deriveChecklistStepDurations,
  enumerateChecklistCheckboxes,
  INTERACTIVE_CHECKLIST_MARKDOWN,
  isSettledSubtaskStatus,
  isTerminalWorkerSignalStatus,
  READINESS_RECORD,
  SUBTASK_INDEX_FILE,
  subtaskPaths,
  SUBTASKS_DIR,
  type TaskOperation,
  WORKER_SIGNAL_FILE,
} from '@farmslot/protocol';
import {
  ACCEPTANCE_STATUS_ARTIFACT,
  acceptanceCriteriaView,
  acceptanceCriterionId,
  type AcceptanceCriterionView,
  type AcceptanceStatusLedger,
  validateAcceptanceStatusLedger,
} from '@farmslot/protocol/contracts/acceptance';
import { processIdentity, readOperations } from '@farmslot/recipe-runner/runtime/operation';

import { readCommandJournal } from './command-journal.js';
import { resolveRuntimeContextPath } from './overlay.js';
import { PREPARE_PROGRESS_ARTIFACT, recipeRuntimeDir } from './paths.js';

// RECIPE_LIBRARY_PATH as the task view lists it: name=path or a bare path, each
// resolved; an entry without a name keeps none.
function parseLibraryPathEnv(value: string | undefined): Array<{ name?: string; root: string }> {
  if (!value) return [];
  return value
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const equals = entry.indexOf('=');
      if (equals === -1) return { root: path.resolve(entry) };
      return {
        name: entry.slice(0, equals).trim(),
        root: path.resolve(entry.slice(equals + 1).trim()),
      };
    });
}

// A prepare step id as prepare records it in its progress file.
const PREPARE_STEP_ID = /^[a-z][a-z0-9-]*$/u;

export const CHECKLIST_LABEL_LIMIT = 70;

export interface TaskViewCheckout {
  target: string;
  branch?: string;
  head?: string;
}

export interface TaskViewIsolation {
  slotId?: string;
  platform?: string;
  metroPort?: number;
  watcherPort?: number;
  devServerPort?: number;
  simulator?: string;
  simulatorUdid?: string;
  cdpPort?: number;
  extensionId?: string;
}

export interface TaskViewHarness {
  version?: string;
  sourceKind?: string;
}

export interface TaskViewTemplate {
  id?: string;
  sourceId?: string;
  flow?: string;
  domain?: string;
  surface?: string;
  title?: string;
  ticket?: string;
}

export interface TaskViewLibrary {
  name?: string;
  path: string;
}

export interface TaskViewFixture {
  fixture?: string;
  canonicalFixture?: string;
  status?: string;
  walletReset?: boolean;
}

export interface TaskViewSandbox {
  ready?: boolean;
}

export interface TaskViewRow {
  /** The second-level heading this row sits under in CHECKLIST.md, when there is one. */
  phase?: string;
  number: number;
  label: string;
  checked: boolean;
  /** Time from the previous marked row (or the handoff start) to this mark. */
  durationMs?: number;
  /** Time since the last mark, on the row the agent is working now. */
  runningMs?: number;
}

/** Where a child unit's markdown came from, as `mark` recorded it. */
export interface TaskViewSubtaskSource {
  kind?: string;
  ref?: string;
}

/**
 * A child checklist unit registered on one parent row (ADR-060). Its rows are
 * enumerated by the same protocol parser as the parent checklist, so a row here
 * is the box `mark sub <id> <n>` ticks.
 */
export interface TaskViewSubtask {
  id: string;
  /** 1-based parent row this unit owns. */
  parentStep: number;
  status?: string;
  /** False while the unit still owns its parent row (`running` or `blocked`). */
  settled: boolean;
  rows: TaskViewRow[];
  source?: TaskViewSubtaskSource;
}

export interface TaskViewSignal {
  status?: string;
  step?: string;
  timestamp?: string;
  attemptId?: string;
}

export interface TaskView {
  operations: Array<TaskOperation & { ownerAlive: boolean }>;
  checkout: TaskViewCheckout;
  taskDir?: string;
  isolation?: TaskViewIsolation;
  harness?: TaskViewHarness;
  template?: TaskViewTemplate;
  acceptance?: AcceptanceCriterionView[];
  libraries: TaskViewLibrary[];
  fixture?: TaskViewFixture;
  sandbox?: TaskViewSandbox;
  prepare?: TaskViewPrepare;
  checklist: TaskViewRow[];
  /** Child units registered on this task's rows, in registration order. */
  subtasks: TaskViewSubtask[];
  signal?: TaskViewSignal;
  /** The last journaled harness command run in this checkout (call, run, launch, …). */
  lastCommand?: TaskViewCommand;
  currentStep?: number;
  elapsedMs?: number;
  activity: TaskViewActivity;
}

export interface TaskViewPrepare {
  step: string;
  elapsedMs: number;
  completed: number;
  total: number;
  steps: Array<{ id: string; status: string; durationMs: number }>;
  startedAt: string;
  updatedAt: string;
}

export interface TaskViewCommand {
  command: string;
  /** The first positional argument, e.g. the action of `call` or the recipe of `run`. */
  subject?: string;
  verdict?: string;
  /** When the command finished, or started when it is still running. */
  at?: string;
  /** Time since `at`. */
  ageMs?: number;
}

/** Whether a task is in progress in this checkout, and why not when it is not. */
export interface TaskViewActivity {
  ongoing: boolean;
  reason?: 'no-task' | 'finished' | 'silent';
  /** Time since the task last wrote its signal, ticked a row, or ran a harness command. */
  idleMs?: number;
  /** False when the task names a ticket and the checked-out branch does not carry it. */
  branchCarriesTicket?: boolean;
}

// A task that has neither marked a row nor run a harness command for this long
// is treated as abandoned. A long investigation step keeps running commands
// without ticking rows, so the command journal counts as activity too.
export const TASK_SILENT_AFTER_MS = 10 * 60 * 1000;

// The task directory a `--task` flag did not name: the one written to last
// under temp/tasks/, found the way every Farmslot reader finds it.
export function findTaskDir(target: string): string | undefined {
  return latestTaskDir(path.join(target, 'temp', 'tasks'));
}

export function collectTaskView(
  target: string,
  taskDir: string | undefined,
  now: number,
): TaskView {
  target = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
  taskDir = taskDir && (fs.existsSync(taskDir) ? fs.realpathSync(taskDir) : path.resolve(taskDir));
  const taskIsRunning =
    taskDir && readJsonObject(path.join(taskDir, WORKER_SIGNAL_FILE))?.status === 'running';
  const operations = readOperations(path.join(target, recipeRuntimeDir(), 'operations'))
    .filter(
      (operation) =>
        !taskIsRunning ||
        path
          .resolve(operation.logPath)
          .startsWith(path.resolve(taskDir!, 'artifacts', 'operations') + path.sep),
    )
    .map((operation) => ({
      ...operation,
      ownerAlive:
        operation.status === 'running' &&
        processIdentity(operation.pid) === operation.processStartedAt,
    }));
  const base = {
    operations,
    checkout: readCheckout(target),
    isolation: readIsolation(target),
    libraries: parseLibraryPathEnv(process.env.RECIPE_LIBRARY_PATH).map(
      ({ name, root }): TaskViewLibrary => ({ ...(name ? { name } : {}), path: root }),
    ),
  };
  if (!taskDir) {
    return {
      ...base,
      checklist: [],
      subtasks: [],
      activity: { ongoing: false, reason: 'no-task' },
    };
  }

  const handoff = readJsonObject(path.join(taskDir, HANDOFF_INPUT));
  const fixtures = readJsonObject(path.join(taskDir, 'artifacts', 'prepare', 'fixtures.json'));
  // A skill run keeps its readiness record in the task's artifacts; a dispatched
  // run was prepared before the task directory existed, so its record is the
  // checkout's.
  const sandbox =
    readJsonObject(path.join(taskDir, 'artifacts', READINESS_RECORD)) ??
    readJsonObject(path.join(target, recipeRuntimeDir(), READINESS_RECORD));
  const signal = readJsonObject(path.join(taskDir, WORKER_SIGNAL_FILE));
  const checklist = readChecklistRows(path.join(taskDir, INTERACTIVE_CHECKLIST_MARKDOWN));
  const template = asObject(handoff?.executionTemplate);
  const task = asObject(handoff?.task);
  const rawCriteria = task?.acceptanceCriteria;
  if (rawCriteria !== undefined && !Array.isArray(rawCriteria)) {
    throw new Error(
      `${path.join(taskDir, HANDOFF_INPUT)}: task.acceptanceCriteria must be an array.`,
    );
  }
  const criteria =
    (rawCriteria as unknown[] | undefined)
      ?.map((text, index) => ({
        id: acceptanceCriterionId(index),
        text: String(text),
      }))
      .filter((criterion) => criterion.text.trim().length > 0) ?? [];
  const rawLedger = readJsonObject(path.join(taskDir, ACCEPTANCE_STATUS_ARTIFACT));
  if (rawLedger) {
    const issues = validateAcceptanceStatusLedger(rawLedger);
    if (issues.length > 0) throw new Error(`${ACCEPTANCE_STATUS_ARTIFACT}: ${issues.join('; ')}`);
  }
  const startedAtIso = pickString(handoff, 'startedAt');
  const startedAt = parseTime(startedAtIso);
  const prepare = readPrepareProgress(
    taskDir,
    now,
    startedAt,
    parseTime(pickString(sandbox, 'recordedAt')),
  );
  const timing = applyTiming(checklist, signal, startedAtIso, now);
  const ticket = pickString(task, 'ticket');
  // The journal is checkout-scoped: a command run before this task started
  // belongs to an earlier task, so it is neither shown nor counted as activity.
  const journal = readLastCommand(target, now);
  const commandAt = parseTime(journal?.at);
  const commandCounts =
    commandAt !== undefined && (startedAt === undefined || commandAt >= startedAt);
  const lastCommand = commandCounts ? journal : undefined;
  const activity = taskActivity({
    status: pickString(signal, 'status'),
    lastWrites: [
      startedAt,
      parseTime(pickString(signal, 'timestamp')),
      ...readMarkEvents(signal).map((event) => Date.parse(event.checkedAt)),
      commandCounts ? commandAt : undefined,
      prepare ? parseTime(prepare.updatedAt) : undefined,
      ...operations.flatMap((operation) => [
        parseTime(operation.lastOutputAt),
        parseTime(operation.stageStartedAt),
        parseTime(operation.startedAt),
      ]),
    ],
    branch: base.checkout.branch,
    ticket,
    now,
  });

  return {
    ...base,
    taskDir,
    // The readiness record is the only place a harness records itself for a task.
    harness: section({
      version: pickString(asObject(sandbox?.harness), 'version'),
      sourceKind: pickString(asObject(sandbox?.harness), 'source'),
    }),
    template: section({
      id: pickString(template, 'id'),
      sourceId: pickString(template, 'sourceId'),
      flow: pickString(handoff, 'flow'),
      domain: pickString(handoff, 'domain'),
      surface: pickString(handoff, 'surface'),
      title: pickString(task, 'title'),
      ticket,
    }),
    ...(criteria.length > 0 || rawLedger
      ? {
          acceptance: acceptanceCriteriaView(
            criteria,
            rawLedger ? (rawLedger as unknown as AcceptanceStatusLedger) : null,
          ),
        }
      : {}),
    fixture: section({
      fixture: pickString(fixtures, 'fixture'),
      canonicalFixture: pickString(fixtures, 'canonicalFixture'),
      status: pickString(fixtures, 'status'),
      walletReset: pickBoolean(fixtures, 'walletReset'),
    }),
    sandbox: section({ ready: pickBoolean(sandbox, 'ready') }),
    ...(prepare ? { prepare } : {}),
    checklist,
    subtasks: readSubtasks(taskDir),
    signal: section({
      status: pickString(signal, 'status'),
      step: pickString(signal, 'step'),
      timestamp: pickString(signal, 'timestamp'),
      attemptId: pickString(signal, 'attemptId'),
    }),
    ...(lastCommand ? { lastCommand } : {}),
    ...timing,
    activity,
  };
}

function readPrepareProgress(
  taskDir: string,
  now: number,
  taskStartedAt: number | undefined,
  recordedAt: number | undefined,
): TaskViewPrepare | undefined {
  const progress = readJsonObject(path.join(taskDir, 'artifacts', PREPARE_PROGRESS_ARTIFACT));
  const active = asObject(progress?.active);
  const step = pickString(active, 'id');
  const startedAt = pickString(active, 'startedAt');
  const stepStartedAt = parseTime(startedAt);
  const runStartedAt = parseTime(pickString(progress, 'startedAt'));
  const updatedAtIso = pickString(progress, 'updatedAt');
  const updatedAt = parseTime(updatedAtIso);
  const total = pickNumber(progress, 'total');
  if (
    !step ||
    !PREPARE_STEP_ID.test(step) ||
    stepStartedAt === undefined ||
    runStartedAt === undefined ||
    updatedAt === undefined ||
    now - updatedAt > 30_000 ||
    total === undefined ||
    total < 1 ||
    (taskStartedAt !== undefined && runStartedAt < taskStartedAt) ||
    (recordedAt !== undefined && recordedAt >= runStartedAt)
  )
    return undefined;
  const steps = Array.isArray(progress?.steps)
    ? progress.steps.flatMap((value): TaskViewPrepare['steps'] => {
        const item = asObject(value);
        const id = pickString(item, 'id');
        const status = pickString(item, 'status');
        const durationMs = pickNumber(item, 'durationMs');
        return id &&
          PREPARE_STEP_ID.test(id) &&
          status &&
          ['pass', 'fail', 'skipped'].includes(status) &&
          durationMs !== undefined
          ? [{ id, status, durationMs }]
          : [];
      })
    : [];
  return {
    step,
    startedAt: startedAt as string,
    updatedAt: updatedAtIso as string,
    elapsedMs: Math.max(0, now - stepStartedAt),
    completed: steps.length,
    total,
    steps,
  };
}

// `status` is not journaled, so watching a checkout never counts as its activity.
// The hardened reader refuses symlinks and malformed records; a bad journal
// means no command line, never a dead watch.
function readLastCommand(target: string, now: number): TaskViewCommand | undefined {
  const { record } = readCommandJournal(target);
  if (!record) return undefined;
  // Only a leading positional is a subject (`call ui.navigate`, `run smoke`).
  // Options may precede it and their values are not shown, redacted or not.
  const first = record.args[0];
  const subject = first !== undefined && !first.startsWith('-') ? first : undefined;
  const at = record.finishedAt || record.startedAt;
  const atMs = parseTime(at);
  return {
    command: record.command,
    ...(subject ? { subject } : {}),
    verdict: record.verdict,
    ...(at ? { at } : {}),
    ...(atMs !== undefined ? { ageMs: Math.max(0, now - atMs) } : {}),
  };
}

function taskActivity(input: {
  status: string | undefined;
  lastWrites: Array<number | undefined>;
  branch: string | undefined;
  ticket: string | undefined;
  now: number;
}): TaskViewActivity {
  const writes = input.lastWrites.filter((value): value is number => value !== undefined);
  const idleMs = writes.length > 0 ? input.now - Math.max(...writes) : undefined;
  const branchCarriesTicket =
    input.ticket && input.branch ? input.branch.includes(input.ticket) : undefined;
  const extra = {
    ...(idleMs !== undefined ? { idleMs } : {}),
    ...(branchCarriesTicket !== undefined ? { branchCarriesTicket } : {}),
  };
  // A directory with no signal and no timestamp at all is not a task yet.
  if (input.status === undefined && writes.length === 0)
    return { ongoing: false, reason: 'no-task', ...extra };
  if (isTerminalWorkerSignalStatus(input.status))
    return { ongoing: false, reason: 'finished', ...extra };
  if (idleMs !== undefined && idleMs > TASK_SILENT_AFTER_MS)
    return { ongoing: false, reason: 'silent', ...extra };
  return { ongoing: true, ...extra };
}

// Per-row durations are the protocol's derivation from the mark events, the
// same numbers Command Center shows; this only adds the running row's age and
// the elapsed time, which need the mark instants.
function applyTiming(
  rows: TaskViewRow[],
  signal: Record<string, unknown> | undefined,
  startedAtIso: string | undefined,
  now: number,
): { currentStep?: number; elapsedMs?: number } {
  const events = readMarkEvents(signal);
  const durations = new Map(
    deriveChecklistStepDurations({ schemaVersion: 1, events }, startedAtIso).map((step) => [
      step.stepNumber,
      step.durationMs,
    ]),
  );
  const marks = new Map(events.map((event) => [event.stepNumber, Date.parse(event.checkedAt)]));
  for (const row of rows) {
    const durationMs = durations.get(row.number);
    if (durationMs !== undefined) row.durationMs = durationMs;
  }
  const instants = [...marks.values()];
  const lastAt = instants.length > 0 ? Math.max(...instants) : undefined;
  const firstAt = instants.length > 0 ? Math.min(...instants) : undefined;
  const current = rows.find((row) => !row.checked);
  if (current && lastAt !== undefined) current.runningMs = now - lastAt;
  const origin = parseTime(startedAtIso) ?? firstAt;
  return {
    ...(current ? { currentStep: current.number } : {}),
    ...(origin !== undefined ? { elapsedMs: now - origin } : {}),
  };
}

// Only the allowlisted event fields reach the derivation; the label is display
// text the view never uses.
function readMarkEvents(
  signal: Record<string, unknown> | undefined,
): Array<{ stepNumber: number; label: string; checkedAt: string }> {
  const events = asObject(signal?.checklistTiming)?.events;
  if (!Array.isArray(events)) return [];
  const marks: Array<{ stepNumber: number; label: string; checkedAt: string }> = [];
  for (const entry of events) {
    const event = asObject(entry);
    const stepNumber = pickNumber(event, 'stepNumber');
    const checkedAt = pickString(event, 'checkedAt');
    if (stepNumber === undefined || parseTime(checkedAt) === undefined) continue;
    marks.push({ stepNumber, label: '', checkedAt: checkedAt as string });
  }
  return marks;
}

// Which checkboxes are steps, their numbers and their phases come from the
// Farmslot protocol: the same enumeration the gateway progress view and the
// `mark` helper use, so this view counts the box `mark N` ticks as step N.
function readChecklistRows(file: string): TaskViewRow[] {
  const text = readTextFile(file);
  if (text === undefined) return [];
  return enumerateChecklistCheckboxes(text).map((item) => ({
    ...(item.phase ? { phase: item.phase } : {}),
    number: item.stepNumber,
    label: trimLabel(item.rawLabel),
    checked: item.checked,
  }));
}

// Child units come from the registry `mark` maintains; their paths, their
// settled rule and their row enumeration are all the protocol's, so this view
// shows the same child progress the gateway and Command Center project. A task
// directory with no child unit has no index and reports none.
function readSubtasks(taskDir: string): TaskViewSubtask[] {
  const index = readJsonObject(path.join(taskDir, SUBTASKS_DIR, SUBTASK_INDEX_FILE));
  if (!index) return [];
  const units = index.units;
  if (!Array.isArray(units)) return [];
  const views: TaskViewSubtask[] = [];
  for (const entry of units) {
    const unit = asObject(entry);
    const id = pickString(unit, 'id');
    const parentStep = pickNumber(asObject(unit?.parent), 'stepNumber');
    if (id === undefined || parentStep === undefined) continue;
    // Trust the registry for the id only: the pair's paths are derived, so a
    // rewritten `checklist`/`signal` field cannot point this reader elsewhere.
    const paths = subtaskPaths(id);
    const signal = readJsonObject(path.join(taskDir, paths.signal));
    const status = pickString(signal, 'status');
    const source = asObject(unit?.source);
    views.push({
      id,
      parentStep,
      ...(status !== undefined ? { status } : {}),
      settled: isSettledSubtaskStatus(status),
      rows: readChecklistRows(path.join(taskDir, paths.checklist)),
      ...(section({ kind: pickString(source, 'kind'), ref: pickString(source, 'ref') })
        ? { source: section({ kind: pickString(source, 'kind'), ref: pickString(source, 'ref') }) }
        : {}),
    });
  }
  return views;
}

// Display only. The step name is the protocol's (the gateway and Command Center
// render the same one); the ordinal is dropped because the row already shows
// its number, and the rest is fitted to the terminal.
function trimLabel(text: string): string {
  const plain = checklistStepName(text)
    .replace(/\*\*/gu, '')
    .replace(/^\d+\.\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (plain.length <= CHECKLIST_LABEL_LIMIT) return plain;
  return `${plain.slice(0, CHECKLIST_LABEL_LIMIT).trimEnd()}…`;
}

function readCheckout(target: string): TaskViewCheckout {
  const branch = gitRef(target, '--abbrev-ref');
  const head = gitRef(target, '--short');
  return { target, ...(branch ? { branch } : {}), ...(head ? { head } : {}) };
}

// `--abbrev-ref` and `--short` are sticky output modes, so one rev-parse cannot
// answer both. A checkout that is not a repository yet reports neither.
function gitRef(target: string, mode: string): string | undefined {
  const result = spawnSync('git', ['-C', target, 'rev-parse', mode, 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function readIsolation(target: string): TaskViewIsolation | undefined {
  const context = readJsonObject(resolveRuntimeContextPath(target));
  if (!context) return undefined;
  return section({
    slotId: pickString(context, 'slotId'),
    platform: pickString(context, 'platform'),
    metroPort: pickNumber(context, 'metroPort'),
    watcherPort: pickNumber(context, 'watcherPort'),
    devServerPort: pickNumber(context, 'devServerPort'),
    simulator: pickString(context, 'simulator'),
    simulatorUdid: pickString(context, 'simulatorUdid'),
    cdpPort: pickNumber(context, 'cdpPort'),
    extensionId: pickString(context, 'extensionId'),
  });
}

// A task writes these files as it advances, so one that has not been reached yet
// is simply absent and its section is omitted. Any other read failure, and every
// malformed document, is a broken task directory and must surface.
function readTextFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  const raw = readTextFile(file);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const object = asObject(parsed);
  if (!object) throw new Error(`${file} must contain a JSON object.`);
  return object;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function pickString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickBoolean(
  source: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function section<T extends object>(value: T): T | undefined {
  return Object.values(value).some((entry) => entry !== undefined) ? value : undefined;
}
