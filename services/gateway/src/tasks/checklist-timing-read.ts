import path from 'node:path';

import {
  type AgentContext,
  isTerminalRunStatus,
  isTerminalWorkerSignalStatus,
  type Run,
  type TaskChecklistTiming,
  type TaskProgressStructured,
} from '@farmslot/protocol';
import { signalFileForChecklist } from '@farmslot/protocol/checklist-target';

import { slotFileExists, type SlotLocality, slotReadFile } from '../core/slot-io.js';

import {
  checklistName,
  checklistTimingContext,
  checklistTimingForAttempt,
  isRecord,
  parseChecklistTiming,
} from './checklist-timing.js';

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
    events: checklistTimingForAttempt(marks, startedAt)?.events ?? [],
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  };
  progress.timing = timing;
  if (finishedAt) {
    for (const step of progress.phases.flatMap((phase) => phase.steps)) {
      const child = step.subtask?.progress.timing;
      if (child && !child.finishedAt) child.finishedAt = finishedAt;
    }
  }
}
