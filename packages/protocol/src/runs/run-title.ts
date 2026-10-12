import type { PendingDecision } from '../contracts/runs.js';

export interface DisplayRun {
  ticketOrPr?: string | null;
  summary?: string | null;
  ticketData?: { title?: string | null } | null;
  branch?: string | null;
}

export interface RunDisplayTitle {
  title: string;
  subtitle: string | null;
}

export function runDisplayTitle(run: DisplayRun, maxLength = 120): RunDisplayTitle {
  const taskTitle = cleanDisplayText(run.ticketData?.title, maxLength);
  const summary = cleanDisplayText(run.summary, maxLength);
  const ticket = cleanDisplayText(run.ticketOrPr, maxLength);
  const branch = cleanDisplayText(run.branch, maxLength);
  const title = taskTitle ?? summary ?? ticket ?? branch ?? 'Untitled run';
  const subtitle = [ticket, branch].find((value) => value && value !== title) ?? null;
  return { title, subtitle };
}

export function decisionDisplayTitle(decision: PendingDecision, maxLength = 120): RunDisplayTitle {
  const payload = decision.payload as Record<string, unknown> | undefined;
  const inputSnapshot = recordField(payload, 'inputSnapshot');
  const ticketData = recordField(inputSnapshot, 'ticketData');
  const taskTitle = cleanDisplayText(ticketData?.title, maxLength);
  const runSummary = cleanDisplayText(decision.runMeta?.summary, maxLength);
  const ticket = cleanDisplayText(decision.runMeta?.ticketOrPr, maxLength);
  const decisionTitle = cleanDisplayText(decision.title, maxLength);
  const title = taskTitle ?? runSummary ?? decisionTitle ?? ticket ?? 'Pending decision';
  const subtitle = [decisionTitle, ticket].find((value) => value && value !== title) ?? null;
  return { title, subtitle };
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

/** Extract a human title without changing the task body. Also handles stored legacy summaries. */
export function taskTitleText(value: string, maxLength = 120): string {
  const htmlHeading =
    value.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i) ??
    value.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  const markdownHeading = value.match(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
  const candidate =
    htmlHeading?.[1] ?? markdownHeading?.[1] ?? value.trim().split(/\r?\n/)[0] ?? '';
  const text = candidate
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|[0-9]+);/gi, (entity) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '\"',
        apos: "'",
        nbsp: ' ',
      };
      if (!entity.startsWith('&#')) return named[entity.slice(1, -1).toLowerCase()];
      const code =
        entity[2].toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(3, -1), 16)
          : Number(entity.slice(2, -1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength - 1).trimEnd() + '…' : text;
}

function cleanDisplayText(value: unknown, maxLength = 120): string | null {
  return typeof value === 'string' ? taskTitleText(value, maxLength) || null : null;
}
