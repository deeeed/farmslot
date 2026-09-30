export function isRetiredTerminalTargetError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'TERMINAL_TARGET_RETIRED';
}

export function isRetryableTerminalSubscribeError(err: unknown): boolean {
  if (isRetiredTerminalTargetError(err)) return false;
  if (err instanceof Error && 'code' in err && err.code === 'TERMINAL_TARGET_PENDING') return true;
  const message = err instanceof Error ? err.message : String(err);
  return (
    /not available yet; wait for .*reopen the terminal/i.test(message) ||
    /request terminal\.subscribe timed out after \d+ms/i.test(message) ||
    /(?:^|\s)(?:timed out|timeout)(?:\s|$)/i.test(message)
  );
}
