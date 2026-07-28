export function connectionWaitTerminalError(
  pausedForBackground: boolean,
  lastConnectionError: string | null,
): string | null {
  if (pausedForBackground) return 'Gateway paused while app is in the background';
  if (lastConnectionError?.startsWith('Authentication failed:')) return lastConnectionError;
  return null;
}
