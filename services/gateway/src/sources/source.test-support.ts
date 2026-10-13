import type { RunSourcePlan, SourceLock, SourceMaterialization } from '@farmslot/protocol';
import { sourceLockDigest } from '@farmslot/slot-config/sources';

export function sourceTestLock(nodeId?: string, runId: string | null = 'run-1'): SourceLock {
  const content: Omit<SourceLock, 'digest'> = {
    schemaVersion: 1,
    context: { project: 'demo', ...(runId ? { runId } : {}), ...(nodeId ? { nodeId } : {}) },
    generation: 1,
    declarationRevision: 1,
    pinRevision: 0,
    resolvedAt: '2026-10-13T00:00:00Z',
    packBindings: { demo: { sourceId: 'pack', entry: '.' } },
    entries: [
      {
        sourceId: 'pack',
        kind: 'pack',
        repo: 'https://example.test/team/pack',
        declaredRef: 'main',
        effectiveRef: 'main',
        commit: 'a'.repeat(40),
        objectFormat: 'sha1',
        treeDigest: 'b'.repeat(64),
        resolutionGeneration: 1,
        scope: 'farm',
        dependencies: [],
      },
    ],
  };
  return { ...content, digest: sourceLockDigest(content) };
}

export function sourceTestMaterialization(lock: SourceLock, nodeId: string): SourceMaterialization {
  return {
    lock,
    roots: { pack: '/immutable/pack' },
    receiptPath: '/receipts/source.json',
    receipt: {
      schemaVersion: 1,
      id: `${nodeId}-receipt`,
      nodeId,
      lockDigest: lock.digest,
      verifiedAt: lock.resolvedAt,
      sources: lock.entries.map((entry) => ({
        sourceId: entry.sourceId,
        commit: entry.commit,
        treeDigest: entry.treeDigest,
        protection: 'read-only-volume',
      })),
    },
  };
}

export function sourceTestPlan(lock = sourceTestLock()): RunSourcePlan {
  return { state: 'planned', lock, workerLock: lock, bindings: [lock.packBindings.demo] };
}
