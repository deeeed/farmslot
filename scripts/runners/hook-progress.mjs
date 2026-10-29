export function deriveLastToolProgressAt(event, observedAt, previousValue, reset) {
  if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure')
    return observedAt;
  return reset ? null : (previousValue ?? null);
}
