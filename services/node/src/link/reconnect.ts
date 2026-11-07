export const MAX_TRANSPORT_BACKOFF = 2000;
export const AUTH_RETRY_DELAY = 30_000;

/** Spread reconnects without shortening an operator-action authentication cooldown. */
export function nodeLinkReconnectDelay(backoff: number, random = Math.random): number {
  const jitter = Math.max(0, Math.min(1, random()));
  return backoff >= AUTH_RETRY_DELAY
    ? Math.round(backoff * (1 + jitter * 0.2))
    : Math.min(MAX_TRANSPORT_BACKOFF, Math.round(backoff * (0.8 + jitter * 0.4)));
}
