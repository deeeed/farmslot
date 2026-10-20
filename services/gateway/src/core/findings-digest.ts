import { createHash } from 'node:crypto';

/** One digest of a findings set: the result decision's (ADR-065 Amendment 7) and the gate's (Amendment 8). */
export function findingsDigest(findings: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(findings)).digest('hex')}`;
}
