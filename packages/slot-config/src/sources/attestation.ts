import path from 'node:path';

import type { SourceLock, SourceMaterialization } from '@farmslot/protocol';

import { sourceDigest } from './git.js';
import { assertSourceLock } from './lock.js';

export function assertSourceAttestation(
  lock: SourceLock,
  nodeId: string,
  value: SourceMaterialization,
): void {
  assertSourceLock(value.lock);
  const facts = lock.entries.map((entry) => ({
    sourceId: entry.sourceId,
    commit: entry.commit,
    treeDigest: entry.treeDigest,
    protection: 'read-only-volume',
  }));
  if (
    sourceDigest(value.lock) !== sourceDigest(lock) ||
    value.receipt.schemaVersion !== 1 ||
    value.receipt.nodeId !== nodeId ||
    value.receipt.lockDigest !== lock.digest ||
    sourceDigest(value.receipt.sources) !== sourceDigest(facts) ||
    !Number.isFinite(Date.parse(value.receipt.verifiedAt)) ||
    !path.isAbsolute(value.receiptPath) ||
    sourceDigest(Object.keys(value.roots).sort()) !==
      sourceDigest(lock.entries.map((entry) => entry.sourceId).sort()) ||
    Object.values(value.roots).some((root) => !path.isAbsolute(root))
  )
    throw new Error('Execution node attested different or unsupported source inputs');
}
