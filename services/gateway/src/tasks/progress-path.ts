import path from 'node:path';

import { slotFileExists, type SlotLocality } from '../core/slot-io.js';

export const TASK_PROGRESS_MARKDOWN = 'TASK.md';
export const INTERACTIVE_CHECKLIST_MARKDOWN = 'CHECKLIST.md';

/**
 * Resolve which markdown file owns checklist progress for a task directory.
 * Mirrors the active checklist in `checklist-target.json` when present;
 * otherwise TASK.md with CHECKLIST.md override when that file exists.
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
