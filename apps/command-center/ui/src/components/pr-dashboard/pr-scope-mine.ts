import { safeLsGet, safeLsSet } from '../../utils/storage.js';

import type { PRWorkspaceEntry } from './pr-workspace.js';

/**
 * What "Mine" means on the PRs page. A browser-side preference: there is no
 * operator login yet, so each viewer declares the GitHub logins that count as
 * theirs and whether PRs produced by farmslot runs count too.
 */
export interface MineScope {
  logins: string[];
  includeRunOwned: boolean;
  /** PRs the viewer explicitly took over, as `repo#number` (lower-case repo). */
  adopted: string[];
}

export function adoptionKey(key: { repo: string; pr: number }): string {
  return `${key.repo.toLowerCase()}#${key.pr}`;
}

export function isAdopted(scope: MineScope, key: { repo: string; pr: number }): boolean {
  return scope.adopted.includes(adoptionKey(key));
}

export function withAdoption(
  scope: MineScope,
  key: { repo: string; pr: number },
  adopted: boolean,
): MineScope {
  const id = adoptionKey(key);
  const rest = scope.adopted.filter((item) => item !== id);
  return { ...scope, adopted: adopted ? [...rest, id] : rest };
}

const MINE_SCOPE_KEY = 'farmslot:pr-mine-scope';

export function normalizeLogins(logins: readonly string[]): string[] {
  return [
    ...new Set(logins.map((login) => login.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)),
  ];
}

export function parseLoginList(text: string): string[] {
  return normalizeLogins(text.split(/[\s,]+/));
}

/** Saved preference, or null when the viewer has not set one yet. */
export function loadMineScope(): MineScope | null {
  const raw = safeLsGet(MINE_SCOPE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Partial<MineScope>;
    return {
      logins: Array.isArray(value.logins) ? normalizeLogins(value.logins.map(String)) : [],
      includeRunOwned: value.includeRunOwned !== false,
      adopted: Array.isArray(value.adopted)
        ? value.adopted.map(String).map((item) => item.toLowerCase())
        : [],
    };
  } catch {
    // A hand-edited or pre-schema value: fall back to the default rather than
    // rendering an empty board with no way to recover.
    return null;
  }
}

export function saveMineScope(scope: MineScope): void {
  safeLsSet(
    MINE_SCOPE_KEY,
    JSON.stringify({
      logins: normalizeLogins(scope.logins),
      includeRunOwned: scope.includeRunOwned,
      adopted: scope.adopted,
    }),
  );
}

/** `owner/repo#123`: the run family started from an existing PR rather than creating one. */
const PR_REF = /^[^\s/]+\/[^\s#]+#\d+$/;

/**
 * A farmslot run "created" the PR when its family root is a ticket or task,
 * not a PR reference. A pr-complete or review run started on someone else's
 * PR makes that PR run-owned without making it the viewer's.
 */
export function isRunCreatedPR(status: PRWorkspaceEntry['status']): boolean {
  if (status?.ownedFamily !== true) return false;
  const root = status.familyRootTicketOrPr?.trim() ?? '';
  return root !== '' && !PR_REF.test(root);
}

export function isMineEntry(entry: PRWorkspaceEntry, scope: MineScope): boolean {
  if (isAdopted(scope, entry.key)) return true;
  if (scope.includeRunOwned && isRunCreatedPR(entry.status)) return true;
  const author = entry.author?.trim().toLowerCase();
  return author !== undefined && author !== '' && scope.logins.includes(author);
}

export function describeMineScope(scope: MineScope): string {
  const who = scope.logins.length ? scope.logins.map((l) => `@${l}`).join(', ') : 'no logins';
  const base = scope.includeRunOwned ? `${who} + PRs farmslot created` : who;
  return scope.adopted.length ? `${base} + ${scope.adopted.length} taken over` : base;
}
