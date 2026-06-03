// chat/safe-client-context.ts — Sanitize untrusted Command Center UI context for prompts.

import type { ChatClientContext } from '@farmslot/protocol';

import { COMMAND_CENTER_SURFACES } from './command-center-surfaces.js';

const CLIENT_CONTEXT_STRING_LIMIT = 200;
const CLIENT_CONTEXT_HASH_LIMIT = 500;
const CLIENT_CONTEXT_LIST_LIMIT = 8;
const CLIENT_CONTEXT_QUERY_LIMIT = 12;
const ALLOWED_QUERY_KEYS = new Set(
  COMMAND_CENTER_SURFACES.flatMap((surface) => surface.queryParams),
);

type ChatClientContextStringKey = Exclude<
  keyof ChatClientContext,
  | 'query'
  | 'compareRunIds'
  | 'affordances'
  | 'visibleElementTags'
  | 'visibleTextSnippets'
  | 'visibleControls'
>;

const CLIENT_CONTEXT_STRING_FIELDS: ReadonlyArray<{
  key: ChatClientContextStringKey;
  limit?: number;
}> = [
  { key: 'url', limit: CLIENT_CONTEXT_HASH_LIMIT },
  { key: 'route' },
  { key: 'hash', limit: CLIENT_CONTEXT_HASH_LIMIT },
  { key: 'surfaceId' },
  { key: 'routePattern' },
  { key: 'selectedRunId' },
  { key: 'selectedFamilyId' },
  { key: 'selectedStepName' },
  { key: 'selectedSlotId' },
  { key: 'selectedDecisionId' },
  { key: 'selectedConfigName' },
  { key: 'selectedPullRequestNumber' },
  { key: 'selectedPullRequestRepo' },
  { key: 'selectedPullRequestRef' },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeContextString(
  value: unknown,
  limit = CLIENT_CONTEXT_STRING_LIMIT,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

function sanitizeContextStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((item) => sanitizeContextString(item))
    .filter((item): item is string => !!item)
    .slice(0, CLIENT_CONTEXT_LIST_LIMIT);
  return out.length ? out : undefined;
}

export function sanitizeChatClientContext(context: unknown): ChatClientContext | undefined {
  if (!isObject(context)) return undefined;
  const safe: ChatClientContext = {};
  const unknownInput = context;
  for (const { key, limit } of CLIENT_CONTEXT_STRING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(unknownInput, key)) continue;
    const value = sanitizeContextString(unknownInput[key], limit ?? CLIENT_CONTEXT_STRING_LIMIT);
    if (value) safe[key] = value;
  }

  if (isObject(unknownInput.query)) {
    const query: Record<string, string> = {};
    const allowedQueryEntries = Object.entries(unknownInput.query)
      .filter(([key]) => ALLOWED_QUERY_KEYS.has(key))
      .slice(0, CLIENT_CONTEXT_QUERY_LIMIT);
    for (const [key, value] of allowedQueryEntries) {
      const safeValue = sanitizeContextString(value);
      if (safeValue) query[key] = safeValue;
    }
    if (Object.keys(query).length > 0) safe.query = query;
  }

  const compareRunIds = sanitizeContextStringList(unknownInput.compareRunIds);
  if (compareRunIds) safe.compareRunIds = compareRunIds;
  const affordances = sanitizeContextStringList(unknownInput.affordances);
  if (affordances) safe.affordances = affordances;
  const visibleElementTags = sanitizeContextStringList(unknownInput.visibleElementTags);
  if (visibleElementTags) safe.visibleElementTags = visibleElementTags;
  const visibleTextSnippets = sanitizeContextStringList(unknownInput.visibleTextSnippets);
  if (visibleTextSnippets) safe.visibleTextSnippets = visibleTextSnippets;
  const visibleControls = sanitizeContextStringList(unknownInput.visibleControls);
  if (visibleControls) safe.visibleControls = visibleControls;

  return Object.keys(safe).length > 0 ? safe : undefined;
}
