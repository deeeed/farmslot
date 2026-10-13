import type { SourcesStatusResult } from '../../src/rpc/sources.js';

export function sourceStatusFixture(): SourcesStatusResult {
  const declaration = { id: 'pack', kind: 'pack' as const, repo: 'https://example.test/team/pack' };
  const entry = {
    sourceId: 'pack',
    kind: 'pack' as const,
    repo: declaration.repo,
    declaredRef: 'main',
    effectiveRef: 'main',
    commit: 'a'.repeat(40),
    objectFormat: 'sha1' as const,
    treeDigest: 'b'.repeat(64),
    resolutionGeneration: 1,
    scope: 'farm' as const,
    dependencies: [],
  };
  return {
    configured: true,
    declarationRevision: 1,
    pinRevision: 2,
    declarations: [declaration],
    effectiveSelections: [
      {
        sourceId: 'pack',
        declaredRef: 'main',
        effectiveRef: 'experiment',
        scope: 'farm',
        shadowedPins: [],
      },
    ],
    resolutions: [
      {
        sourceId: 'pack',
        ref: 'experiment',
        declarationRevision: 1,
        generation: 2,
        commit: 'c'.repeat(40),
        status: 'resolved',
        rewrites: [],
      },
    ],
    locks: [
      {
        schemaVersion: 1,
        context: { project: 'demo', runId: 'retained' },
        generation: 1,
        declarationRevision: 1,
        pinRevision: 0,
        resolvedAt: '2026-10-12T00:00:00Z',
        entries: [entry],
        packBindings: { demo: { sourceId: 'pack', entry: '.' } },
        digest: 'd'.repeat(64),
      },
    ],
    nodes: [
      {
        nodeId: 'node-1',
        materializations: [
          {
            lockDigest: 'd'.repeat(64),
            sources: [
              {
                sourceId: 'pack',
                commit: entry.commit,
                treeDigest: entry.treeDigest,
                protection: 'read-only-volume',
              },
            ],
            verifiedAt: '2026-10-12T00:00:00Z',
            drift: [],
          },
        ],
      },
    ],
    errors: [],
  };
}
