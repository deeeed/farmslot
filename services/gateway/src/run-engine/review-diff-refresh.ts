import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ReviewDiffSnapshot,
  reviewSnapshotIdentityText,
  type ReviewStatus,
  type Run,
  verifiedReviewDiffHash,
} from '@farmslot/protocol';

import { loadSlotVars, SlotConfigError } from '../core/config.js';
import { slotFileExists, slotReadFile } from '../core/slot-io.js';
import { resolveWorkerTaskDir } from '../review/templates.js';

async function readSnapshotDiff(
  run: Run,
  snapshot: ReviewDiffSnapshot,
): Promise<string | undefined> {
  const relativePath = snapshot.diffPath;
  if (
    !run.taskFile ||
    !relativePath ||
    !/^(artifacts|inputs)\//.test(relativePath) ||
    relativePath.split('/').includes('..')
  )
    return undefined;
  const localPath = path.join(path.dirname(run.taskFile), relativePath);
  if (existsSync(localPath)) return readFile(localPath, 'utf8');
  if (!run.slotId) return undefined;
  let vars: Awaited<ReturnType<typeof loadSlotVars>>;
  try {
    vars = await loadSlotVars(run.slotId);
  } catch (error) {
    // A retired slot cannot supply historical evidence. Leave its review stale.
    if (error instanceof SlotConfigError && error.code === 'SLOT_NOT_FOUND') {
      console.warn(
        `[publish-review] run ${run.id}: historical diff unavailable on retired slot ${run.slotId}`,
      );
      return undefined;
    }
    throw error;
  }
  const taskDir = await resolveWorkerTaskDir(vars, run.project, run.taskFile);
  if (!taskDir) return undefined;
  const remotePath = path.posix.join(vars.remoteRepo, taskDir, relativePath);
  return (await slotFileExists(vars, remotePath)) ? slotReadFile(vars, remotePath) : undefined;
}

/** Upgrade only a historical identity whose captured bytes still verify. */
export async function refreshReviewDiffSnapshot(
  run: Run,
  snapshot: ReviewDiffSnapshot,
  capturedSnapshots: readonly ReviewDiffSnapshot[] = [],
): Promise<ReviewDiffSnapshot> {
  if (!snapshot.diffHash) return snapshot;
  // Older package captures have no diffPath. A review of the same immutable range
  // can supply the bytes, but they must verify against the package's own digest.
  const candidates = [
    ...(snapshot.diffPath ? [snapshot] : []),
    ...capturedSnapshots.filter(
      (candidate) =>
        candidate.source === snapshot.source &&
        candidate.baseSha === snapshot.baseSha &&
        candidate.headSha === snapshot.headSha &&
        candidate.diffPath,
    ),
  ];
  for (const candidate of candidates) {
    const diff = await readSnapshotDiff(run, candidate);
    if (diff === undefined) continue;
    const identity = reviewSnapshotIdentityText(diff, snapshot.untrackedFiles ?? []);
    const diffHash = verifiedReviewDiffHash(identity, snapshot.diffHash);
    if (diffHash) return diffHash === snapshot.diffHash ? snapshot : { ...snapshot, diffHash };
  }
  return snapshot;
}

/** Preserve the historical artifacts; reconcile only the gate's snapshot identity. */
export async function refreshReviewDiffIdentities(
  run: Run,
  reviews: ReviewStatus[],
): Promise<ReviewStatus[]> {
  return Promise.all(
    reviews.map(async (review) => {
      const snapshot = review.reviewSnapshot;
      if (review.verdict !== 'pass' || !snapshot) return review;
      const refreshed = await refreshReviewDiffSnapshot(run, snapshot);
      return refreshed === snapshot ? review : { ...review, reviewSnapshot: refreshed };
    }),
  );
}
