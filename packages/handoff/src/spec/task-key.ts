import { createHash } from 'node:crypto';

/**
 * Inputs to task-family key derivation. The key identifies the WORK across
 * attempts, independent of who ran it or which agent - same task in, same
 * `taskKey` out, on any machine. There is no coordinator assigning family ids.
 */
export interface TaskKeyInput {
  /** Work identifier when one exists, e.g. `PROJ-1`. Wins over the hash path. */
  ticket?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
}

/** Lowercase, collapse runs of non-alphanumerics to single hyphens, trim hyphens.
 * Also the normalization applied wherever a ticket becomes a path segment. */
export function normalizeTicket(ticket: string): string {
  return ticket
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Whitespace-collapsed lowercase text so formatting noise never splits a family. */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Derive the cross-attempt `taskKey` (spec section 1): the normalized ticket when
 * present, else `task-<16hex>` hashing the normalized task content
 * (title + description + acceptance criteria). Deterministic and non-secret.
 */
export function deriveTaskKey(input: TaskKeyInput): string {
  if (input.ticket !== undefined && input.ticket.trim() !== '') {
    const normalized = normalizeTicket(input.ticket);
    // A punctuation-only ticket normalizes to nothing - fall through to the
    // content-hash path rather than producing an empty (unwritable) key.
    if (normalized !== '') return normalized;
  }
  const normalized = [
    normalizeText(input.title ?? ''),
    normalizeText(input.description ?? ''),
    normalizeText(input.acceptanceCriteria ?? ''),
  ].join('\n');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `task-${digest}`;
}
