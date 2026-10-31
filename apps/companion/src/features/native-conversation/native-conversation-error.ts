/**
 * The one error line a native conversation shows. Offline, a failed read is the outage's, which
 * the heading's "Offline" already says; an action's own failure and a refused account still show.
 */
export function nativeConversationError(
  errors: { action: string; read: string; creation: string | undefined; resume: string },
  connected: boolean,
  allowed: boolean,
): string {
  return (
    errors.action || (connected || !allowed ? errors.read : '') || errors.creation || errors.resume
  );
}
