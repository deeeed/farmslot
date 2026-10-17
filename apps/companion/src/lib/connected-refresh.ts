/**
 * How a screen re-reads a gateway resource across connections. A new target (a new
 * refresh function: another run, recipe run or decision) starts fresh. A reconnect
 * re-reads the same target and keeps what is on screen, so an open viewer survives
 * an app switch or a gateway restart. Nothing is read while disconnected.
 */
export type ConnectedRefresh = { reason: 'initial load' | 'connect'; reset: boolean } | null;

export function connectedRefresh(
  previousTarget: unknown,
  target: unknown,
  connection: number | null,
): ConnectedRefresh {
  if (connection === null) return null;
  return previousTarget === target
    ? { reason: 'connect', reset: false }
    : { reason: 'initial load', reset: true };
}
