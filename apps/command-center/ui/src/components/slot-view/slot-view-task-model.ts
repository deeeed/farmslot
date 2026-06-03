import type { SlotStatus, TaskProgressStructured } from '@farmslot/protocol';

import type { TaskStep } from './slot-view-model.js';

export function formatSlotViewDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function hasSlotViewActiveTask(
  structuredProgress: TaskProgressStructured | undefined,
  taskSteps: readonly TaskStep[],
): boolean {
  return !!(structuredProgress || taskSteps.length > 0);
}

export function shouldShowSlotViewTaskUi(
  slot: SlotStatus | null,
  structuredProgress: TaskProgressStructured | undefined,
  taskSteps: readonly TaskStep[],
): boolean {
  if (!slot?.taskFile) return false;
  return (
    slot.lifecycle === 'busy' ||
    slot.phase === 'ci-watch' ||
    hasSlotViewActiveTask(structuredProgress, taskSteps)
  );
}
