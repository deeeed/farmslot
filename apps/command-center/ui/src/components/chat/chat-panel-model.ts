import { CHAT_ACTION_REJECT_REASONS, chatActionRejectCode } from '@farmslot/protocol';

export const DEFAULT_DRAWER_HEIGHT = 420;
export const MIN_DRAWER_HEIGHT = 320;
export const ACTIVE_SESSION_KEY = 'farmslot:copilot-active-session';
export const SHARED_SESSION_ID = 'global';
const LEGACY_DEFAULT_SESSION_ID = 'default';

// Every typed reject reason maps to "this card cannot complete from here" —
// the operator must reissue, not retry. Including precondition-fail covers
// permanent gates like RequiresExplicitMergeMain or terminal-run rejects.
// Derived from the protocol-level reason list so a new reason auto-extends
// the UI without a separate edit.
export const UNAVAILABLE_REJECT_CODES: ReadonlySet<string> = new Set(
  CHAT_ACTION_REJECT_REASONS.map(chatActionRejectCode),
);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function chatSessionDisplayName(sessionId: string): string {
  if (sessionId === SHARED_SESSION_ID) return 'Shared chat';
  const separator = sessionId.indexOf(':');
  const scope = separator >= 0 ? sessionId.slice(0, separator) : sessionId;
  const id = separator >= 0 ? sessionId.slice(separator + 1) : '';
  if (scope === 'run' && id) return `Run ${id}`;
  if (scope === 'family' && id) return `Family ${id}`;
  if (scope === 'slot' && id) return `Slot ${id}`;
  return sessionId;
}

export function normalizeStoredSessionId(value: string | null): string {
  if (!value || value === LEGACY_DEFAULT_SESSION_ID) return SHARED_SESSION_ID;
  return value;
}

export function formatChatInt(value: number | null | undefined): string {
  return value === null || value === undefined ? 'unknown' : Math.round(value).toLocaleString();
}

export function formatChatUsd(value: number | undefined): string {
  return value === undefined ? '$0.0000' : `$${value.toFixed(4)}`;
}

export function clampChatDrawerHeight(
  height: number,
  viewportHeight: number,
  minHeight = MIN_DRAWER_HEIGHT,
): number {
  const max = Math.max(minHeight, viewportHeight - 48);
  return Math.min(max, Math.max(minHeight, Math.round(height)));
}
