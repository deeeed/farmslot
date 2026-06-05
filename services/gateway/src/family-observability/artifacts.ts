// artifacts.ts — Family observability artifact discovery and normalization helpers

import type { FamilyObservabilityArtifact, Run } from '@farmslot/protocol';

export function dedupeArtifacts(
  items: FamilyObservabilityArtifact[],
): FamilyObservabilityArtifact[] {
  const byPath = new Map<string, FamilyObservabilityArtifact>();
  for (const item of items) {
    const key = [item.sourceRunId ?? item.runId, item.path].join('|');
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, item);
      continue;
    }
    const preferred = existing.stepName == null && item.stepName != null ? item : existing;
    byPath.set(key, {
      ...preferred,
      purpose: preferred.purpose ?? existing.purpose ?? item.purpose,
      sizeBytes: preferred.sizeBytes ?? existing.sizeBytes ?? item.sizeBytes,
      sha256: preferred.sha256 ?? existing.sha256 ?? item.sha256,
      maxFps: preferred.maxFps ?? existing.maxFps ?? item.maxFps,
    });
  }
  return [...byPath.values()];
}

export function inferPurpose(filename: string): string {
  if (/\.(png|jpg|jpeg|gif)$/i.test(filename)) {
    if (filename.includes('before')) return 'screenshot-before';
    if (filename.includes('after')) return 'screenshot-after';
    return 'screenshot';
  }
  if (/\.(mp4|mov|webm)$/i.test(filename)) {
    if (filename.includes('before')) return 'video-before';
    if (filename.includes('after')) return 'video-after';
    return 'video';
  }
  if (filename === 'report.md') return 'report';
  if (filename === 'review.md') return 'review';
  if (filename === 'recipe.json') return 'recipe';
  if (filename === 'recipe-quality.json') return 'recipe-quality';
  if (filename === 'recipe-coverage.md') return 'recipe-coverage';
  if (filename === 'learnings.md') return 'learnings';
  if (filename === 'family-scope.json') return 'family-scope';
  if (filename === 'diff.txt') return 'diff';
  if (filename === 'diff-stat.json') return 'diff-stat';
  if (filename === 'commit.json') return 'input-commit';
  return 'other';
}

export function inferInputPurpose(filename: string): string {
  if (filename === 'diff.txt') return 'input-diff';
  if (filename === 'diff-stat.json') return 'input-diff-stat';
  return inferPurpose(filename);
}

export function stepArtifacts(
  run: Run,
  stepName: string,
  outputs: Record<string, unknown> | undefined,
): FamilyObservabilityArtifact[] {
  const raw = Array.isArray((outputs as { artifacts?: unknown[] } | undefined)?.artifacts)
    ? ((outputs as { artifacts?: Array<Record<string, unknown>> }).artifacts ?? [])
    : [];
  return raw
    .map((artifact): FamilyObservabilityArtifact | null => {
      const pathValue = typeof artifact.path === 'string' ? artifact.path : null;
      if (!pathValue) return null;
      return {
        runId: run.id,
        familyId: run.familyId,
        stepName,
        path: pathValue,
        purpose: typeof artifact.purpose === 'string' ? artifact.purpose : inferPurpose(pathValue),
        sizeBytes: typeof artifact.sizeBytes === 'number' ? artifact.sizeBytes : undefined,
        sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : undefined,
        maxFps:
          typeof artifact.maxFps === 'number' && Number.isFinite(artifact.maxFps)
            ? artifact.maxFps
            : undefined,
        source: 'step-output' as const,
      };
    })
    .flatMap((entry) => (entry ? [entry] : []));
}
