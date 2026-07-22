import path from 'node:path';

import type { RecipeArtifactType } from '@farmslot/protocol';

export interface LatestValidRecipeRunPointer {
  version: number;
  runId: string;
  relativeArtifactRoot: string;
  updatedAt?: string;
}

const EXACT_ARTIFACT_PURPOSES = new Map<string, string>([
  ['report.md', 'report'],
  ['review.md', 'review'],
  ['line-comments.json', 'line-comments'],
  ['recipe.json', 'recipe'],
  ['recipe-quality.json', 'recipe-quality'],
  ['recipe-coverage.md', 'recipe-coverage'],
  ['learnings.md', 'learnings'],
  ['artifact-manifest.json', 'artifact-manifest'],
  ['evidence-manifest.json', 'evidence-manifest'],
  ['pr-description.md', 'pr-description'],
  ['pr-package.json', 'pr-package-json'],
  ['pr-package.md', 'pr-package-md'],
]);

const TYPED_ARTIFACT_PURPOSES = new Map<RecipeArtifactType, string>([
  ['screenshot', 'screenshot'],
  ['log', 'log'],
  ['trace', 'trace'],
  ['summary', 'summary'],
  ['json', 'json'],
  ['report', 'report'],
  ['metric', 'metric'],
  ['diff', 'diff'],
  ['recipe', 'recipe'],
  ['other', 'other'],
]);

export function inferTypedArtifactPurpose(type: string, relativePath: string): string {
  if (type === 'video') {
    const inferred = inferArtifactPurpose(relativePath);
    return inferred.startsWith('video') ? inferred : 'video';
  }
  return TYPED_ARTIFACT_PURPOSES.get(type as RecipeArtifactType) ?? 'other';
}

export function inferArtifactPurpose(relativePath: string): string {
  const filename = path.basename(relativePath);
  if (relativePath.startsWith('recipe-library/recipes/') && filename.endsWith('.recipe.json')) {
    return 'recipe-library';
  }
  const exactPurpose = EXACT_ARTIFACT_PURPOSES.get(filename);
  if (exactPurpose) return exactPurpose;
  if (/\.(png|jpg|jpeg|gif)$/i.test(filename)) {
    if (relativePath.startsWith('screenshots/')) return 'debug-screenshot';
    return 'screenshot';
  }
  if (/\.(mp4|mov|webm)$/i.test(filename)) {
    if (filename.includes('before')) return 'video-before';
    if (filename.includes('after')) return 'video-after';
    return 'video';
  }
  if (/\.(jsonl)$/i.test(filename)) return 'log';
  if (/\.(js|ts)$/i.test(filename)) return 'script';
  return 'other';
}

export function sanitizeLatestValidRecipeRunPointer(
  pointer: LatestValidRecipeRunPointer | null | undefined,
): LatestValidRecipeRunPointer | null {
  if (!pointer?.relativeArtifactRoot || pointer.version !== 1) return null;
  const cleaned = path.posix.normalize(pointer.relativeArtifactRoot.replaceAll('\\', '/'));
  if (cleaned === '..' || cleaned.startsWith('../') || path.posix.isAbsolute(cleaned)) return null;
  if (!cleaned.startsWith('recipe-runs/')) return null;
  const runId = cleaned.slice('recipe-runs/'.length).split('/')[0];
  if (!runId) return null;
  return {
    ...pointer,
    runId,
    relativeArtifactRoot: cleaned,
  };
}
