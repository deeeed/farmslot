import type { PendingDecision, Run } from '@farmslot/protocol';

type DisplayRun = Pick<Run, 'ticketOrPr' | 'summary' | 'ticketData' | 'branch'>;

export interface RunDisplayTitle {
  title: string;
  subtitle: string | null;
}

export function runDisplayTitle(run: DisplayRun): RunDisplayTitle {
  const taskTitle = cleanDisplayText(run.ticketData?.title);
  const summary = cleanDisplayText(run.summary);
  const ticket = cleanDisplayText(run.ticketOrPr);
  const branch = cleanDisplayText(run.branch);
  const title = taskTitle ?? summary ?? ticket ?? branch ?? 'Untitled run';
  const subtitle = [ticket, branch].find((value) => value && value !== title) ?? null;
  return { title, subtitle };
}

export function decisionDisplayTitle(decision: PendingDecision): RunDisplayTitle {
  const payload = decision.payload as Record<string, unknown> | undefined;
  const inputSnapshot = recordField(payload, 'inputSnapshot');
  const ticketData = recordField(inputSnapshot, 'ticketData');
  const taskTitle = stringField(ticketData, 'title');
  const runSummary = cleanDisplayText(decision.runMeta?.summary);
  const ticket = cleanDisplayText(decision.runMeta?.ticketOrPr);
  const decisionTitle = cleanDisplayText(decision.title);
  const title = taskTitle ?? runSummary ?? decisionTitle ?? ticket ?? 'Pending decision';
  const subtitle = [decisionTitle, ticket].find((value) => value && value !== title) ?? null;
  return { title, subtitle };
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  if (!record) return null;
  return cleanDisplayText(record[key]);
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cleanDisplayText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}
