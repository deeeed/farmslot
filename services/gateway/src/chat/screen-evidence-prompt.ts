// chat/screen-evidence-prompt.ts — Compact client screen evidence for LLM prompts.

import type { ScreenEvidenceSnapshot } from '@farmslot/protocol';

export const SCREEN_EVIDENCE_PROMPT_MAX_BYTES = 4_096;
const SCREEN_EVIDENCE_LIST_LIMIT = 4;
const SCREEN_EVIDENCE_QUERY_LIMIT = 12;
const SCREEN_EVIDENCE_STRING_LIMIT = 200;

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const suffix = '\n...<truncated>';
  const bodyBudget = Math.max(0, maxBytes - byteLength(suffix));
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const nextBytes = byteLength(ch);
    if (bytes + nextBytes > bodyBudget) break;
    out += ch;
    bytes += nextBytes;
  }
  return `${out}${suffix}`;
}

function compactSnapshotList(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  return values.slice(0, SCREEN_EVIDENCE_LIST_LIMIT).map((value) => truncateUtf8(value, 160));
}

function compactSnapshotQuery(
  query: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!query) return undefined;
  const entries = Object.entries(query).slice(0, SCREEN_EVIDENCE_QUERY_LIMIT);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([key, value]) => [key, truncateUtf8(value, SCREEN_EVIDENCE_STRING_LIMIT)]),
  );
}

export function serializeScreenEvidenceForPrompt(snapshot: ScreenEvidenceSnapshot): string {
  const compact: ScreenEvidenceSnapshot = { ...snapshot };
  const query = compactSnapshotQuery(snapshot.query);
  if (query) compact.query = query;
  else delete compact.query;
  for (const key of [
    'compareRunIds',
    'affordances',
    'preferredTools',
    'visibleElementTags',
    'visibleTextSnippets',
    'visibleControls',
  ] as const) {
    const value = compactSnapshotList(snapshot[key]);
    if (value) compact[key] = value;
    else delete compact[key];
  }
  return truncateUtf8(JSON.stringify(compact, null, 2), SCREEN_EVIDENCE_PROMPT_MAX_BYTES);
}
