import path from 'node:path';

import {
  type AgentContext,
  isTerminalRunStatus,
  isTerminalWorkerSignalStatus,
  type Run,
  type TaskChecklistTiming,
  type TaskProgressStructured,
  type WorkerSignalChecklistEvent,
  type WorkerSignalChecklistTiming,
} from '@farmslot/protocol';
import { signalFileForChecklist } from '@farmslot/protocol/checklist-target';

import { slotFileExists, type SlotLocality, slotReadFile } from '../core/slot-io.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shared read of parent and child mark histories. Never coerce malformed JSON fields. */
export function parseChecklistTiming(value: unknown): WorkerSignalChecklistTiming | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.events)) return null;
  const events: WorkerSignalChecklistEvent[] = [];
  for (const raw of value.events) {
    if (!isRecord(raw)) continue;
    const { stepNumber, label, checkedAt } = raw;
    if (typeof stepNumber !== 'number' || !Number.isInteger(stepNumber) || stepNumber < 1) continue;
    if (
      typeof label !== 'string' ||
      typeof checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(checkedAt))
    )
      continue;
    events.push({ stepNumber, label, checkedAt });
  }
  return {
    schemaVersion: 1,
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
    events,
  };
}

function checklistName(taskFile: string): string {
  const name = path.basename(taskFile);
  return name === 'TASK.md' ? 'CHECKLIST.md' : name;
}

/** Select the context owning the file being read, rather than the run's other active role. */
export function checklistTimingContext(
  run: Run | undefined,
  checklist: string,
  selected?: AgentContext | null,
): AgentContext | undefined {
  const matches = (context: AgentContext) =>
    context.taskFile && checklistName(context.taskFile) === checklistName(checklist);
  if (selected && matches(selected)) return selected;
  return run?.agentContexts
    ?.filter(matches)
    .sort((a, b) =>
      (b.attemptStartedAt ?? b.startedAt ?? '').localeCompare(
        a.attemptStartedAt ?? a.startedAt ?? '',
      ),
    )[0];
}

export async function attachChecklistTiming(
  io: SlotLocality,
  checklist: string,
  progress: TaskProgressStructured,
  run?: Run,
  selected?: AgentContext | null,
): Promise<void> {
  const context = checklistTimingContext(run, checklist, selected);
  const startedAt = context?.attemptStartedAt ?? context?.startedAt;
  const primary = checklistName(checklist) === 'CHECKLIST.md';
  const signalPath = path.join(
    path.dirname(checklist),
    signalFileForChecklist(path.basename(checklist)),
  );
  let raw: unknown;
  if (await slotFileExists(io, signalPath)) {
    const text = await slotReadFile(io, signalPath);
    try {
      raw = JSON.parse(text);
    } catch (err) {
      // A concurrent rewrite can be incomplete. The next signal event re-reads it.
      console.warn(
        `[task-progress] unreadable timing signal ${signalPath}: ${(err as Error).message}`,
      );
    }
  }
  if (
    isRecord(raw) &&
    ((raw.contextId && context && raw.contextId !== context.id) ||
      (raw.role && context && raw.role !== context.role) ||
      (raw.attemptId && context?.signalAttemptId && raw.attemptId !== context.signalAttemptId) ||
      (startedAt &&
        typeof raw.timestamp === 'string' &&
        Date.parse(raw.timestamp) < Date.parse(startedAt)))
  )
    raw = undefined;
  const marks =
    (isRecord(raw) ? parseChecklistTiming(raw.checklistTiming) : null) ??
    (primary ? run?.metrics.checklistTiming : undefined);
  if (marks?.source && checklistName(marks.source) !== checklistName(checklist)) return;
  if (!marks && !startedAt) return;
  const finishedAt =
    context?.completedAt ??
    (isRecord(raw) &&
    isTerminalWorkerSignalStatus(typeof raw.status === 'string' ? raw.status : null) &&
    typeof raw.timestamp === 'string'
      ? raw.timestamp
      : undefined) ??
    (run && isTerminalRunStatus(run.status) ? (run.completedAt ?? run.updatedAt) : undefined);
  const timing: TaskChecklistTiming = {
    schemaVersion: 1,
    ...(marks?.source ? { source: marks.source } : {}),
    events: (marks?.events ?? []).filter(
      (event) => !startedAt || Date.parse(event.checkedAt) >= Date.parse(startedAt),
    ),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  };
  progress.timing = timing;
}
