import path from 'node:path';

import { slotFileExists, type SlotLocality } from '../core/slot-io.js';

export const TASK_PROGRESS_MARKDOWN = 'TASK.md';
export const INTERACTIVE_CHECKLIST_MARKDOWN = 'CHECKLIST.md';

/**
 * Resolve which markdown file owns checklist progress for a worker task directory.
 * Uses TASK.md with CHECKLIST.md override when that file exists. Role-specific
 * checklists (SELF-REVIEW.md, etc.) come from run.activeTaskFile, not this helper.
 */
export function resolveTaskProgressMarkdownPath(candidatePath: string): string {
  const normalized = path.normalize(candidatePath);
  if (path.basename(normalized) !== TASK_PROGRESS_MARKDOWN) return normalized;
  return path.join(path.dirname(normalized), INTERACTIVE_CHECKLIST_MARKDOWN);
}

export async function resolveTaskProgressMarkdownPathForSlot(
  vars: SlotLocality,
  candidatePath: string,
): Promise<string> {
  const checklistPath = resolveTaskProgressMarkdownPath(candidatePath);
  if (checklistPath === candidatePath) return candidatePath;
  return (await slotFileExists(vars, checklistPath)) ? checklistPath : candidatePath;
}
