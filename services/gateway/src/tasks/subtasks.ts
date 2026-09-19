// Child checklist units (ADR-060 / docs/plans/sub-task-observability-v1.md) as
// the gateway sees them: files under `subtasks/` beside a task directory's
// parent checklist, written only by `mark`. The gateway observes them — it never
// registers, spawns, or completes one.
//
// This module is the single read layer: the watcher uses it to discover which
// child files to watch, `taskProgress` to project them under their parent step,
// the terminal check to refuse a parent completion with an open child, and the
// metrics collector to roll child durations onto the run. Every function takes a
// SlotLocality so a local and a remote slot read through the same code path.

import path from 'node:path';

import {
  isSettledSubtaskStatus,
  isWorkerSignalStatus,
  SUBTASK_ID_PATTERN,
  SUBTASK_INDEX_FILE,
  type SubtaskIndex,
  type SubtaskIndexUnit,
  SUBTASKS_DIR,
  type SubtaskSource,
  type TaskProgressStructured,
  type TaskStepProgress,
  type TaskStepSubtaskProgress,
  type WorkerSignalChecklistEvent,
  type WorkerSignalChecklistTiming,
  type WorkerSignalParentLink,
  type WorkerSignalStatus,
} from '@farmslot/protocol';

import { slotFileExists, type SlotLocality, slotReadFile } from '../core/slot-io.js';

/**
 * How long a `running` child may go without a mark event before the gateway
 * projects it as `stale`.
 *
 * The spec names "the run's existing worker idle threshold" for this, but no
 * such gateway constant exists: worker idleness is decided by the monitor from
 * runner-native signals (busy/idle probes, nudge budgets), not by a single
 * milliseconds value any module exports. A child unit has no runner of its own —
 * its only liveness evidence is its mark timestamps — so this threshold is
 * defined here, at 15 minutes, and is the one value the projection uses.
 */
export const SUBTASK_STALE_AFTER_MS = 15 * 60 * 1000;

/** Task-dir relative path of the child registry, e.g. `subtasks/index.json`. */
export const SUBTASK_INDEX_REL_PATH = `${SUBTASKS_DIR}/${SUBTASK_INDEX_FILE}`;

/** Absolute path of a task directory's child registry. */
export function subtaskIndexPathFor(taskDir: string): string {
  return path.join(taskDir, SUBTASKS_DIR, SUBTASK_INDEX_FILE);
}

/** Absolute path of the `subtasks/` directory beside a parent checklist. */
export function subtasksDirFor(taskDir: string): string {
  return path.join(taskDir, SUBTASKS_DIR);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A required string field, rejected rather than coerced. */
function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${where} must be a non-empty string`);
  return value;
}

/** The parent step a unit hangs off. */
function parseParentLink(value: unknown, where: string): WorkerSignalParentLink {
  if (!isPlainRecord(value)) throw new Error(`${where} must be an object`);
  const checklist = value.checklist;
  const stepNumber = value.stepNumber;
  if (
    typeof checklist !== 'string' ||
    !checklist ||
    typeof stepNumber !== 'number' ||
    !Number.isInteger(stepNumber) ||
    stepNumber < 1
  ) {
    throw new Error(`${where} must be { checklist: string, stepNumber: >=1 }`);
  }
  return { checklist, stepNumber };
}

/**
 * A task-dir relative child path. Rejects anything that leaves `subtasks/`: the
 * registry travels with the task directory, and a traversal entry would make the
 * gateway read outside it.
 */
function parseSubtaskRelPath(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.startsWith(`${SUBTASKS_DIR}/`)) {
    throw new Error(`${where} must be a ${SUBTASKS_DIR}/ relative path (got ${String(value)})`);
  }
  if (path.posix.normalize(value) !== value) {
    throw new Error(`${where} must be a normalized path (got ${value})`);
  }
  return value;
}

/** Where a child checklist came from, with its provenance digests. */
function parseSubtaskSource(value: unknown, where: string): SubtaskSource {
  if (!isPlainRecord(value)) throw new Error(`${where} must be an object`);
  const kind = value.kind;
  if (kind !== 'skill' && kind !== 'template' && kind !== 'inline') {
    throw new Error(`${where}.kind must be skill, template, or inline (got ${String(kind)})`);
  }
  const sha256 = requireString(value.sha256, `${where}.sha256`);
  const renderedSha256 = requireString(value.renderedSha256, `${where}.renderedSha256`);
  const ref = value.ref;
  if (ref !== undefined && typeof ref !== 'string') {
    throw new Error(`${where}.ref must be a string when present`);
  }
  // `inline` carries no ref by contract: the text itself is identified by digest.
  return { kind, sha256, renderedSha256, ...(ref === undefined ? {} : { ref }) };
}

/**
 * Validate one registry entry, field by field. `mark` is the only writer, so
 * anything else is a corrupt file rather than a shape to tolerate: a child whose
 * paths we cannot trust must not be watched or projected. Every field is read
 * through a narrowing check, so nothing here is asserted into its type.
 */
function parseSubtaskIndexUnit(raw: unknown, source: string, position: number): SubtaskIndexUnit {
  const where = `${source} units[${position}]`;
  if (!isPlainRecord(raw)) throw new Error(`${where} is not an object`);
  const id = raw.id;
  if (typeof id !== 'string' || !SUBTASK_ID_PATTERN.test(id)) {
    throw new Error(
      `${where}.id must be a slug matching ${SUBTASK_ID_PATTERN} (got ${String(id)})`,
    );
  }
  return {
    id,
    parent: parseParentLink(raw.parent, `${where}.parent`),
    checklist: parseSubtaskRelPath(raw.checklist, `${where}.checklist`),
    signal: parseSubtaskRelPath(raw.signal, `${where}.signal`),
    source: parseSubtaskSource(raw.source, `${where}.source`),
    registeredAt: requireString(raw.registeredAt, `${where}.registeredAt`),
  };
}

/**
 * Parse `subtasks/index.json`. Throws on any deviation — a present-but-invalid
 * registry is an error the operator must see, never silence that hides a child.
 */
export function parseSubtaskIndex(text: string, source = SUBTASK_INDEX_REL_PATH): SubtaskIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid ${source}: ${(err as Error).message}`);
  }
  if (!isPlainRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.units)) {
    throw new Error(`invalid ${source}: expected { "schemaVersion": 1, "units": [] }`);
  }
  const units = raw.units.map((unit, position) => parseSubtaskIndexUnit(unit, source, position));
  return { schemaVersion: 1, units };
}

/**
 * The child registry beside a task directory, or null when the directory has no
 * child unit. A missing file means "no children"; a present one that does not
 * parse throws.
 */
export async function readSubtaskIndex(
  ctx: SlotLocality,
  taskDir: string,
): Promise<SubtaskIndex | null> {
  const indexPath = subtaskIndexPathFor(taskDir);
  if (!(await slotFileExists(ctx, indexPath))) return null;
  return parseSubtaskIndex(await slotReadFile(ctx, indexPath), indexPath);
}

/** Registered units hanging off one parent checklist basename. */
export function subtaskUnitsForParentChecklist(
  index: SubtaskIndex | null,
  parentChecklistBasename: string,
): SubtaskIndexUnit[] {
  if (!index) return [];
  return index.units.filter((unit) => unit.parent.checklist === parentChecklistBasename);
}

/**
 * The fields the gateway reads from a child signal file, each narrowed at the
 * read rather than asserted. `mark` writes these files, but they are still
 * untyped JSON on arrival: an unparseable status or timing block is dropped here
 * so nothing downstream has to re-check it.
 */
export interface SubtaskSignalRead {
  status: WorkerSignalStatus | null;
  /** Newest child mark, or the signal timestamp when it has marked nothing yet. */
  lastEventAt: string | null;
  /** The child's append-only mark history, when it carries a valid one. */
  checklistTiming?: WorkerSignalChecklistTiming;
}

function parseChecklistTiming(value: unknown): WorkerSignalChecklistTiming | null {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.events)) {
    return null;
  }
  const events: WorkerSignalChecklistEvent[] = [];
  for (const raw of value.events) {
    if (!isPlainRecord(raw)) continue;
    const { stepNumber, label, checkedAt } = raw;
    if (typeof stepNumber !== 'number' || !Number.isInteger(stepNumber)) continue;
    if (typeof label !== 'string' || typeof checkedAt !== 'string') continue;
    events.push({ stepNumber, label, checkedAt });
  }
  const source = value.source;
  return {
    schemaVersion: 1,
    ...(typeof source === 'string' ? { source } : {}),
    events,
  };
}

/** Narrow one child signal's JSON to what the projection and metrics need. */
export function parseSubtaskSignal(raw: unknown): SubtaskSignalRead {
  if (!isPlainRecord(raw)) return { status: null, lastEventAt: null };
  const timing = parseChecklistTiming(raw.checklistTiming);
  let latest: string | null = null;
  for (const event of timing?.events ?? []) {
    if (latest === null || event.checkedAt > latest) latest = event.checkedAt;
  }
  const timestamp = raw.timestamp;
  return {
    status: isWorkerSignalStatus(raw.status) ? raw.status : null,
    lastEventAt: latest ?? (typeof timestamp === 'string' ? timestamp : null),
    ...(timing ? { checklistTiming: timing } : {}),
  };
}

/** A child signal as the gateway reads it, or null when the file is absent. */
async function readChildSignal(
  ctx: SlotLocality,
  taskDir: string,
  unit: SubtaskIndexUnit,
): Promise<SubtaskSignalRead | null> {
  const signalPath = path.join(taskDir, unit.signal);
  if (!(await slotFileExists(ctx, signalPath))) return null;
  const text = await slotReadFile(ctx, signalPath);
  try {
    return parseSubtaskSignal(JSON.parse(text));
  } catch (err) {
    // A signal caught mid-write is the one read failure that is genuinely
    // expected here: `mark` writes atomically but a remote read can still land
    // on a truncated frame. The next watch event re-reads it; treating it as
    // "no signal yet" keeps the projection honest instead of failing the whole
    // progress call for a transient partial read.
    console.warn(
      `[subtasks] ignoring unparseable child signal ${unit.signal}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Status as clients should read it. `stale` is a projection and only a
 * projection: it is never written to a child signal, and only a `running` child
 * whose last event is older than {@link SUBTASK_STALE_AFTER_MS} gets it. A
 * blocked or settled child keeps its own status however old it is — the file
 * already explains why it stopped moving.
 */
export function projectSubtaskStatus(
  status: WorkerSignalStatus | null,
  lastEventAt: string | null,
  nowMs: number,
  staleAfterMs: number = SUBTASK_STALE_AFTER_MS,
): WorkerSignalStatus | 'stale' | null {
  if (status !== 'running') return status;
  if (!lastEventAt) return 'running';
  const lastMs = Date.parse(lastEventAt);
  if (!Number.isFinite(lastMs)) return 'running';
  return nowMs - lastMs > staleAfterMs ? 'stale' : 'running';
}

/** Count of checked / total child steps, from the child's own progress schema. */
export function buildSubtaskEntry(
  unit: SubtaskIndexUnit,
  progress: TaskProgressStructured,
  signal: SubtaskSignalRead | null,
  nowMs: number,
): TaskStepSubtaskProgress {
  const lastEventAt = signal?.lastEventAt ?? null;
  const status = projectSubtaskStatus(signal?.status ?? null, lastEventAt, nowMs);
  return {
    id: unit.id,
    // A registered child with no readable signal has not reported yet; it is
    // running by construction (`sub start` writes `running` with the file).
    status: status ?? 'running',
    source: unit.source,
    progress,
    lastEventAt,
  };
}

/** Every step of a structured projection, flattened in schema order. */
function structuredSteps(structured: TaskProgressStructured): TaskStepProgress[] {
  return structured.phases.flatMap((phase) => phase.steps);
}

/**
 * Attach a child projection to the parent step that owns it. Returns false when
 * the parent step number is not in this projection — a child registered against
 * a checklist row that has since been renumbered, which the caller logs rather
 * than silently dropping.
 */
export function attachSubtaskToStep(
  structured: TaskProgressStructured,
  stepNumber: number,
  entry: TaskStepSubtaskProgress,
): boolean {
  const step = structuredSteps(structured).find((candidate) => candidate.index === stepNumber);
  if (!step) return false;
  step.subtask = entry;
  return true;
}

export interface SubtaskUnitRead {
  unit: SubtaskIndexUnit;
  markdown: string;
  signal: SubtaskSignalRead | null;
}

/**
 * Read each child unit's checklist markdown and signal. A unit whose checklist
 * is missing is skipped with a warning: the registry names it, but there is
 * nothing to enumerate, and the parent's own progress must still be returned.
 */
export async function readSubtaskUnits(
  ctx: SlotLocality,
  taskDir: string,
  units: readonly SubtaskIndexUnit[],
): Promise<SubtaskUnitRead[]> {
  const reads: SubtaskUnitRead[] = [];
  for (const unit of units) {
    const checklistPath = path.join(taskDir, unit.checklist);
    if (!(await slotFileExists(ctx, checklistPath))) {
      console.warn(`[subtasks] registered unit ${unit.id} has no checklist at ${unit.checklist}`);
      continue;
    }
    reads.push({
      unit,
      markdown: await slotReadFile(ctx, checklistPath),
      signal: await readChildSignal(ctx, taskDir, unit),
    });
  }
  return reads;
}

export interface OpenSubtaskUnit {
  unit: SubtaskIndexUnit;
  status: WorkerSignalStatus | null;
}

/**
 * Registered units that have not finished. Settled is `complete` or `done` via
 * the protocol helper; a `blocked` child is still open and still owns its
 * parent step, so a parent completion must not pass while one exists.
 */
export async function listOpenSubtaskUnits(
  ctx: SlotLocality,
  taskDir: string,
): Promise<OpenSubtaskUnit[]> {
  const index = await readSubtaskIndex(ctx, taskDir);
  if (!index) return [];
  const open: OpenSubtaskUnit[] = [];
  for (const unit of index.units) {
    const status = (await readChildSignal(ctx, taskDir, unit))?.status ?? null;
    if (!isSettledSubtaskStatus(status)) open.push({ unit, status });
  }
  return open;
}

/** Worker-facing description of the open children blocking a terminal mark. */
export function openSubtaskContractMessage(
  open: readonly OpenSubtaskUnit[],
  terminalCommand: string,
): string {
  const detail = open
    .map((entry) => `${entry.unit.id} (${entry.status ?? 'no signal'})`)
    .join(', ');
  const finish = open.map((entry) => `./mark sub ${entry.unit.id} complete`).join(' && ');
  return (
    `Terminal signal rejected: subtask ${open.length === 1 ? 'unit' : 'units'} still open: ${detail}. ` +
    `A registered child checklist is part of this step's proof, so ./mark ${terminalCommand} cannot ` +
    `pass while one is running or blocked. Finish it with ${finish}, then run ./mark ${terminalCommand} again.`
  );
}
