import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactRef,
  isPublishEvidenceArtifact,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type ReviewDiffSnapshot,
  type Run,
} from '@farmslot/protocol';

import { sha256File } from '../core/file-hash.js';

import { evidenceKeyVariants, resolveSelectedEvidenceRef } from './evidence-paths.js';
import { retainedRunBundleRef, retainedRunTaskDirectory } from './retained-artifacts.js';

export { sha256File } from '../core/file-hash.js';
export { resolveSelectedEvidenceRef } from './evidence-paths.js';

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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

function reviewSnapshotSubject(snapshot: ReviewDiffSnapshot) {
  return {
    source: snapshot.source,
    baseRef: snapshot.baseRef,
    baseSha: snapshot.baseSha,
    headRef: snapshot.headRef,
    headSha: snapshot.headSha,
    diffHash: snapshot.diffHash,
    missingReason: snapshot.missingReason,
    error: snapshot.error,
  };
}

function packageSemanticHashPayload(
  prPackage: ReadyGatePrPackageWithoutHash,
): Record<string, unknown> {
  const {
    id: _id,
    artifactPath: _artifactPath,
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
            ...reviewSnapshotSubject(reviewSnapshot),
            diffStat: reviewSnapshot.diffStat,
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
 * validation summary. Description, human override receipts and display counts
 * do not change that subject. The package hashes still cover those fields.
 * A refresh reprojects older packages with this function before restamping
 * reviews whose captured code snapshot is still current.
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
      kind: 'ready-gate-review-subject-v3',
      branch: payload.branch,
      remoteBranchRef: payload.remoteBranchRef,
      headSha: payload.headSha,
      evidenceManifest: reviewEvidenceManifest,
      selectedEvidenceKeys:
        canonicalSelectedEvidenceKeys.length > 0
          ? canonicalSelectedEvidenceKeys
          : payload.selectedEvidenceKeys,
      validationSummaryHash: payload.validationSummaryHash,
      reviewSnapshot: prPackage.reviewSnapshot
        ? reviewSnapshotSubject(prPackage.reviewSnapshot)
        : undefined,
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

/** The one action that rebuilds a package from the current task. */
export function refreshPackageStep(runId: string): string {
  return (
    `To refresh, click "Refresh current package" on the Ready gate or run: ` +
    `farmslot rpc run.refreshPublishPackage '${JSON.stringify({ runId })}'`
  );
}

/**
 * A stale-package refusal at approval: names what changed and the one action
 * that rebuilds the package, so the operator is not left at a dead end.
 */
export function packageChangedError(runId: string, detail: string): Error {
  return new Error(
    `Package changed; refresh package and re-review before publishing (${detail}). ` +
      refreshPackageStep(runId),
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
  const retained = current.decisions
    .slice()
    .reverse()
    .find(
      (decision) =>
        decision.payload?.kind === 'ready' &&
        decision.payload.prPackage?.id === current.engineState?.publishGate?.packageId &&
        decision.payload.prPackage?.packageHash === current.engineState?.publishGate?.packageHash,
    );
  if (retained?.payload?.kind === 'ready' && retained.payload.prPackage)
    return retained.payload.prPackage;
  if (!current.taskFile) return undefined;
  // This gateway control record is written after capture to carry the payload's
  // digest. It cannot be part of its own content-addressed payload. No slot I/O.
  try {
    return JSON.parse(
      await readFile(path.join(path.dirname(current.taskFile), artifactRel), 'utf8'),
    ) as ReadyGatePrPackage;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function verifyReadyGateSelectedEvidenceFiles(
  current: Run,
  preparedPackage: Partial<ReadyGatePrPackage>,
  selectedEvidenceKeys: string[],
  invalidEvidence: (runId: string, detail: string) => Error = packageChangedError,
): Promise<void> {
  if (!current.taskFile) throw new Error('Approved package evidence requires a task directory');
  const taskDir = await retainedRunTaskDirectory(
    current,
    preparedPackage.artifactBundle ?? retainedRunBundleRef(current),
  );
  const evidenceByPath = new Map(
    (preparedPackage.evidenceManifest ?? []).map((artifact) => [artifact.path, artifact]),
  );
  for (const key of selectedEvidenceKeys) {
    const evidence =
      evidenceByPath.get(key) ??
      resolveSelectedEvidenceRef(key, preparedPackage.evidenceManifest ?? []);
    if (!evidence) {
      throw invalidEvidence(current.id, `selected evidence missing from package: ${key}`);
    }
    const artifactPath = path.resolve(taskDir, evidence.path);
    const relative = path.relative(taskDir, artifactPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(artifactPath)) {
      throw invalidEvidence(current.id, `selected evidence file missing: ${evidence.path}`);
    }
    const resolvedRelative = path.relative(await realpath(taskDir), await realpath(artifactPath));
    if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
      throw invalidEvidence(current.id, `selected evidence escapes the task: ${evidence.path}`);
    }
    const info = await stat(artifactPath);
    if (!info.isFile() || info.size === 0) {
      throw invalidEvidence(
        current.id,
        `selected evidence is empty or not a file: ${evidence.path}`,
      );
    }
    if (evidence.sha256) {
      const actual = await sha256File(artifactPath);
      if (actual !== evidence.sha256) {
        throw invalidEvidence(current.id, `selected evidence hash mismatch: ${evidence.path}`);
      }
    }
  }
}
