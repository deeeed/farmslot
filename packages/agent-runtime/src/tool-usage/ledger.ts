// Checklist marks from the mark ledger: SIGNAL.json `checklistTiming` (schemaVersion 1), which
// the gateway also keeps as `run.metrics.checklistTiming`. Nothing here depends on the runner.

export interface ChecklistMark {
  stepNumber: number;
  label: string;
  checkedAt: string;
  skipped?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valid marks in ledger order. Malformed entries are dropped, as the gateway reader does. */
export function checklistMarks(timing: unknown): ChecklistMark[] {
  if (!isRecord(timing) || timing.schemaVersion !== 1 || !Array.isArray(timing.events)) return [];
  const marks: ChecklistMark[] = [];
  for (const event of timing.events) {
    if (!isRecord(event)) continue;
    const { stepNumber, label, checkedAt, skipped } = event;
    if (typeof stepNumber !== 'number' || !Number.isInteger(stepNumber) || stepNumber < 1) continue;
    if (typeof label !== 'string' || typeof checkedAt !== 'string') continue;
    if (!Number.isFinite(Date.parse(checkedAt))) continue;
    marks.push({ stepNumber, label, checkedAt, ...(skipped === true ? { skipped: true } : {}) });
  }
  return marks;
}

/** Marks from a parsed SIGNAL.json document. */
export function checklistMarksFromSignal(signal: unknown): ChecklistMark[] {
  return isRecord(signal) ? checklistMarks(signal.checklistTiming) : [];
}
