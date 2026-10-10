import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactRef,
  isPublishEvidenceArtifact,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type Run,
} from '@farmslot/protocol';

import { evidenceKeyVariants, resolveSelectedEvidenceRef } from './evidence-paths.js';

export { resolveSelectedEvidenceRef } from './evidence-paths.js';

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sortArtifactRefsForComparison(artifacts: ArtifactRef[]): ArtifactRef[] {
  return [...artifacts].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      String(a.purpose ?? '').localeCompare(String(b.purpose ?? '')) ||
      (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1) ||
      String(a.sha256 ?? '').localeCompare(String(b.sha256 ?? '')),
  );
}

type ReadyGatePrPackageWithoutHash = Omit<ReadyGatePrPackage, 'packageHash'> & {
  packageHash?: string;
};

export function computeReadyGatePackageHash(prPackage: ReadyGatePrPackageWithoutHash): string {
  const { packageHash: _packageHash, ...withoutHash } = prPackage;
  return sha256Text(stableJson(withoutHash));
}

function packageSemanticHashPayload(
  prPackage: ReadyGatePrPackageWithoutHash,
): Record<string, unknown> {
  const {
    id: _id,
    packageHash: _packageHash,
    packageInputHash: _packageInputHash,
    reviewSubjectHash: _reviewSubjectHash,
    publicationTarget: _publicationTarget,
    publicationStatus: _publicationStatus,
    createdAt: _createdAt,
    approvedAt: _approvedAt,
    supersededByPackageId: _supersededByPackageId,
    reviewSnapshot,
    ...semantic
  } = prPackage;
  return {
    ...semantic,
    ...(reviewSnapshot
      ? {
          reviewSnapshot: {
            source: reviewSnapshot.source,
            baseRef: reviewSnapshot.baseRef,
            baseSha: reviewSnapshot.baseSha,
            headRef: reviewSnapshot.headRef,
            headSha: reviewSnapshot.headSha,
            diffHash: reviewSnapshot.diffHash,
            diffStat: reviewSnapshot.diffStat,
            missingReason: reviewSnapshot.missingReason,
            error: reviewSnapshot.error,
          },
        }
      : {}),
  };
}

export function computeReadyGatePackageInputHash(prPackage: ReadyGatePrPackageWithoutHash): string {
  return sha256Text(
    stableJson({
      kind: 'ready-gate-package-input-v1',
      package: packageSemanticHashPayload(prPackage),
    }),
  );
}

/**
 * What a review certifies: the branch, HEAD, diff, selected evidence and
 * validation summary. The title and body are left out (v2), so editing the
 * description never makes a review stale; the package hash still covers them.
 * Hashes stamped under v1 stay comparable: stored stamps are compared with the
 * stored package hash, and a refresh recomputes both packages with this one.
 */
export function computeReadyGateReviewSubjectHash(
  prPackage: ReadyGatePrPackageWithoutHash,
): string {
  const payload = packageSemanticHashPayload(prPackage);
  const selectedEvidenceKeys = Array.isArray(payload.selectedEvidenceKeys)
    ? (payload.selectedEvidenceKeys as string[])
    : [];
  const evidenceManifest = Array.isArray(payload.evidenceManifest)
    ? (payload.evidenceManifest as ArtifactRef[])
    : [];
  const canonicalSelectedEvidenceKeys =
    selectedEvidenceKeys.length > 0
      ? [
          ...new Set(
            selectedEvidenceKeys
              .map((key) => resolveSelectedEvidenceRef(key, evidenceManifest)?.path ?? key)
              .filter((key): key is string => typeof key === 'string'),
          ),
        ].sort()
      : [];
  const selectedEvidence = new Set(selectedEvidenceKeys.flatMap((key) => evidenceKeyVariants(key)));
  const reviewEvidenceManifest = sortArtifactRefsForComparison(
    evidenceManifest.filter((artifact) =>
      selectedEvidence.size > 0
        ? evidenceKeyVariants(artifact.path).some((variant) => selectedEvidence.has(variant))
        : isPublishEvidenceArtifact(artifact),
    ),
  );
  return sha256Text(
    stableJson({
      kind: 'ready-gate-review-subject-v2',
      branch: payload.branch,
      remoteBranchRef: payload.remoteBranchRef,
      headSha: payload.headSha,
      diffStat: payload.diffStat,
      evidenceManifest: reviewEvidenceManifest,
      selectedEvidenceKeys:
        canonicalSelectedEvidenceKeys.length > 0
          ? canonicalSelectedEvidenceKeys
          : payload.selectedEvidenceKeys,
      validationSummaryHash: payload.validationSummaryHash,
      reviewSnapshot: payload.reviewSnapshot,
    }),
  );
}

/**
 * The description the Ready gate shows instead of the package's own: the given
 * title and body when they differ from the reviewed package's, or always once
 * published. The package and its hash are untouched.
 */
export function readyGateCurrentDescription(
  prPackage: Pick<ReadyGatePrPackage, 'draftTitle' | 'draftBody'>,
  description: Pick<ReadyGatePrPackage, 'draftTitle' | 'draftBody'>,
  publishedAt?: string,
): ReadyGatePayload['currentDescription'] {
  if (
    !publishedAt &&
    description.draftTitle === prPackage.draftTitle &&
    description.draftBody === prPackage.draftBody
  ) {
    return undefined;
  }
  return {
    title: description.draftTitle,
    body: description.draftBody,
    ...(publishedAt ? { publishedAt } : {}),
  };
}

/**
 * A stale-package refusal at approval: names what changed and the one action
 * that rebuilds the package, so the operator is not left at a dead end.
 */
export function packageChangedError(runId: string, detail: string): Error {
  return new Error(
    `Package changed; refresh package and re-review before publishing (${detail}). ` +
      `To refresh, click "Refresh current package" on the Ready gate or run: ` +
      `farmslot rpc run.refreshPublishPackage '${JSON.stringify({ runId })}'`,
  );
}

/** Refuse publishing when the slot HEAD is no longer the package's HEAD. */
export function assertLiveHeadMatchesPackage(
  runId: string,
  approvedHead: string,
  liveHead: string,
): void {
  if (liveHead && liveHead === approvedHead) return;
  throw packageChangedError(
    runId,
    `approved HEAD ${approvedHead.slice(0, 12)} but live HEAD is ${liveHead ? liveHead.slice(0, 12) : 'unknown'}`,
  );
}

export function verifyReadyGatePackageHash(prPackage: ReadyGatePrPackage): void {
  const expected = computeReadyGatePackageHash(prPackage);
  if (expected !== prPackage.packageHash) {
    throw new Error(
      `Package changed; refresh package and re-review before publishing (package hash mismatch: expected ${expected} but found ${prPackage.packageHash})`,
    );
  }
}

export async function readReadyGatePreparedPackage(
  current: Run,
): Promise<ReadyGatePrPackage | undefined> {
  const artifactRel =
    current.engineState?.publishGate?.packageArtifactPath ?? 'artifacts/pr-package.json';
  if (!current.taskFile) return undefined;
  const artifactPath = path.join(path.dirname(current.taskFile), artifactRel);
  if (!existsSync(artifactPath)) return undefined;
  return JSON.parse(await readFile(artifactPath, 'utf-8')) as ReadyGatePrPackage;
}

export async function verifyReadyGateSelectedEvidenceFiles(
  current: Run,
  preparedPackage: Partial<ReadyGatePrPackage>,
  selectedEvidenceKeys: string[],
): Promise<void> {
  if (!current.taskFile) throw new Error('Approved package evidence requires a task directory');
  const taskDir = path.dirname(current.taskFile);
  const evidenceByPath = new Map(
    (preparedPackage.evidenceManifest ?? []).map((artifact) => [artifact.path, artifact]),
  );
  for (const key of selectedEvidenceKeys) {
    const evidence =
      evidenceByPath.get(key) ??
      resolveSelectedEvidenceRef(key, preparedPackage.evidenceManifest ?? []);
    if (!evidence) {
      throw packageChangedError(current.id, `selected evidence missing from package: ${key}`);
    }
    const artifactPath = path.resolve(taskDir, evidence.path);
    const relative = path.relative(taskDir, artifactPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(artifactPath)) {
      throw packageChangedError(current.id, `selected evidence file missing: ${evidence.path}`);
    }
    const resolvedRelative = path.relative(await realpath(taskDir), await realpath(artifactPath));
    if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
      throw packageChangedError(current.id, `selected evidence escapes the task: ${evidence.path}`);
    }
    const info = await stat(artifactPath);
    if (!info.isFile() || info.size === 0) {
      throw packageChangedError(
        current.id,
        `selected evidence is empty or not a file: ${evidence.path}`,
      );
    }
    if (evidence.sha256) {
      const actual = await sha256File(artifactPath);
      if (actual !== evidence.sha256) {
        throw packageChangedError(current.id, `selected evidence hash mismatch: ${evidence.path}`);
      }
    }
  }
}
