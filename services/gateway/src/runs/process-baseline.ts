import path from 'node:path';

import { sha256Text as hash } from '@farmslot/agent-runtime';
import {
  type ArtifactRef,
  digestRecipeDocument,
  type EvidenceManifest,
  isRecord,
  type ProcessActivitySource,
  type ProcessBaselineRun,
  validateArtifactManifestDocument,
} from '@farmslot/protocol';

import { normalizeEvidenceManifestArtifactPath } from '../run-completion/evidence-manifest.js';

export interface CapturedBaseline {
  first: ProcessBaselineRun | null;
  sources: ProcessActivitySource[];
  complete: boolean;
}

/** Phase comes from the task's declaration; directory names never classify a baseline. */
export interface ProcessBaselineRequest {
  manifest?: EvidenceManifest;
  inventory: readonly ArtifactRef[];
  contextId: string;
  node: string;
  readText(file: string): Promise<string | null>;
}

export async function observeProcessBaselines(
  input: ProcessBaselineRequest,
): Promise<CapturedBaseline> {
  const { manifest, inventory, contextId, node, readText } = input;
  const result: CapturedBaseline = { first: null, sources: [], complete: false };
  if (!manifest) return result;
  const before = [
    ...(manifest.before_after_pairs ?? []).map((pair) => pair.before),
    manifest.videos?.before,
  ]
    .filter((file): file is string => typeof file === 'string')
    .map((file) => normalizeEvidenceManifestArtifactPath(file, { mediaOnly: false }))
    .filter((file): file is string => Boolean(file));
  if (!before.length) return result;
  const covered = new Set<string>();
  const candidates = inventory.filter(
    (artifact) =>
      artifact.path.endsWith('/summary.json') &&
      before.some((file) => file.startsWith(`${path.posix.dirname(artifact.path)}/`)),
  );
  const directories = candidates.map((artifact) => path.posix.dirname(artifact.path));
  const directRoots = new Set(
    before.map(
      (file) =>
        directories
          .filter((directory) => file.startsWith(`${directory}/`))
          .sort((a, b) => b.length - a.length)[0],
    ),
  );
  for (const candidate of candidates.slice(0, 64)) {
    const directory = path.posix.dirname(candidate.path);
    const manifestBytes = await readText(`${directory}/artifact-manifest.json`);
    if (!manifestBytes) continue;
    const entries: unknown = JSON.parse(manifestBytes);
    if (
      validateArtifactManifestDocument(entries).status !== 'valid' ||
      !isRecord(entries) ||
      !Array.isArray(entries.artifacts)
    )
      continue;
    const artifactEntries = entries.artifacts;
    const matched = before.filter((file) =>
      artifactEntries.some(
        (entry: unknown) =>
          isRecord(entry) &&
          typeof entry.path === 'string' &&
          path.posix.join(directory, entry.path) === file,
      ),
    );
    // A declared before path can name a real attempt whose media claim is invalid.
    // Keep its execution metadata, but only declared manifest entries establish coverage.
    if (!matched.length && !directRoots.has(directory)) continue;
    const summaryBytes = await readText(candidate.path);
    const invocationBytes = await readText(`${directory}/recipe-invocation.json`);
    if (!summaryBytes || !invocationBytes) continue;
    const summary: unknown = JSON.parse(summaryBytes),
      invocation: unknown = JSON.parse(invocationBytes);
    if (
      !isRecord(summary) ||
      !isRecord(invocation) ||
      typeof summary.recipeRunId !== 'string' ||
      typeof summary.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(summary.startedAt)) ||
      summary.recipeRunId !== invocation.recipeRunId ||
      summary.startedAt !== invocation.startedAt ||
      summary.invocationDigest !== digestRecipeDocument(invocation)
    )
      continue;
    const key = `baseline:${summary.recipeRunId}:${hash(directory).slice(0, 12)}`;
    const id = `${key}:summary`;
    const metadata = [
      [candidate.path, summaryBytes, id],
      [`${directory}/recipe-invocation.json`, invocationBytes, `${key}:invocation`],
      [`${directory}/artifact-manifest.json`, manifestBytes, `${key}:manifest`],
    ];
    if (
      metadata.some(
        ([file, bytes]) => inventory.find((item) => item.path === file)?.sha256 !== hash(bytes),
      )
    )
      continue;
    for (const [file, bytes, sourceId] of metadata)
      result.sources.push({
        id: sourceId,
        kind: 'task-artifact',
        contextId: contextId,
        executionNodeId: node,
        clockId: `node:${node}`,
        path: file,
        sha256: hash(bytes),
      });
    const observed = {
      at: summary.startedAt,
      recipeRunId: summary.recipeRunId,
      source: { sourceId: id },
    };
    if (!result.first || Date.parse(observed.at) < Date.parse(result.first.at))
      result.first = observed;
    for (const file of matched) covered.add(file);
  }
  result.complete = candidates.length <= 64 && before.every((file) => covered.has(file));
  return result;
}
