export function decisionPayloadKind(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const kind = (payload as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}
