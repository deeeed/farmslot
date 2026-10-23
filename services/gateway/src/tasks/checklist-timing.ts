import path from 'node:path';

import {
  type AgentContext,
  type Run,
  type WorkerSignalChecklistEvent,
  type WorkerSignalChecklistTiming,
} from '@farmslot/protocol';

export function isRecord(value: unknown): value is Record<string, unknown> {
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

export function checklistName(taskFile: string): string {
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

/** Use the same attempt boundary for live progress and retained monthly analytics. */
export function checklistTimingForAttempt(
  timing: WorkerSignalChecklistTiming | null | undefined,
  startedAt?: string,
): WorkerSignalChecklistTiming | undefined {
  if (!timing) return undefined;
  return {
    ...timing,
    events: timing.events.filter(
      (event) => !startedAt || Date.parse(event.checkedAt) >= Date.parse(startedAt),
    ),
  };
}
