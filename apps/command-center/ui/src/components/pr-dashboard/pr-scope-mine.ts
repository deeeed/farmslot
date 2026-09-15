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
    }),
  );
}

export function isMineEntry(entry: PRWorkspaceEntry, scope: MineScope): boolean {
  if (scope.includeRunOwned && entry.status?.ownedFamily === true) return true;
  const author = entry.author?.trim().toLowerCase();
  return author !== undefined && author !== '' && scope.logins.includes(author);
}

export function describeMineScope(scope: MineScope): string {
  const who = scope.logins.length ? scope.logins.map((l) => `@${l}`).join(', ') : 'no logins';
  return scope.includeRunOwned ? `${who} + farmslot runs` : who;
}
