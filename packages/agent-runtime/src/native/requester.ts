import type { NativeSessionRequester } from '@farmslot/protocol';

export function parseNativeSessionRequester(value: unknown): NativeSessionRequester | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native requester attribution');
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).some((key) => key !== 'principalId' && key !== 'principalGeneration') ||
    typeof p.principalId !== 'string' ||
    !p.principalId.trim() ||
    typeof p.principalGeneration !== 'number' ||
    !Number.isSafeInteger(p.principalGeneration) ||
    p.principalGeneration < 0
  )
    throw new Error('Invalid native requester attribution');
  return { principalId: p.principalId, principalGeneration: p.principalGeneration };
}
