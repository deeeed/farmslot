export function isRetryableTerminalSubscribeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /not available yet; wait for .*reopen the terminal/i.test(message) ||
    /request terminal\.subscribe timed out after \d+ms/i.test(message) ||
    /(?:^|\s)(?:timed out|timeout)(?:\s|$)/i.test(message)
  );
}

// Gateway rejected subscribe because role window / agent context is gone. Phrases come from
// gateway/src/methods/terminal.ts (assertInteractiveTargetReady) and agent-contexts.ts. Match
// on phrase fragments via includes() rather than `.* .*` regexes — real error strings can
// carry multi-line stack traces and greedy regex would slurp across them.
const ROLE_WINDOW_MISSING_PHRASES = [
  'is not available yet; wait for that worker window',
  'no active agent context',
  'no active agent role',
] as const;

export function isRoleWindowMissingError(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return ROLE_WINDOW_MISSING_PHRASES.some((phrase) => lower.includes(phrase));
}
