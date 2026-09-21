import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { IndependentReviewStatus, ReviewDiffSnapshot, Run } from '@farmslot/protocol';

import { loadSlotVars, SlotConfigError } from '../core/config.js';
import { verifiedReviewDiffHash } from '../core/review-diff-identity.js';
import { slotFileExists, slotReadFile } from '../core/slot-io.js';
import { reviewSnapshotIdentityText } from '../self-review/snapshots.js';
import { resolveWorkerTaskDir } from '../self-review/templates.js';

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

/** Preserve the historical artifacts; reconcile only the gate's snapshot identity. */
export async function refreshReviewDiffIdentities(
  run: Run,
  reviews: IndependentReviewStatus[],
): Promise<IndependentReviewStatus[]> {
  return Promise.all(
    reviews.map(async (review) => {
      const snapshot = review.reviewSnapshot;
      if (review.verdict !== 'pass' || !snapshot?.diffHash) return review;
      const diff = await readSnapshotDiff(run, snapshot);
      if (diff === undefined) return review;
      const identity = reviewSnapshotIdentityText(diff, snapshot.untrackedFiles ?? []);
      const diffHash = verifiedReviewDiffHash(identity, snapshot.diffHash);
      if (!diffHash || diffHash === snapshot.diffHash) return review;
      return { ...review, reviewSnapshot: { ...snapshot, diffHash } };
    }),
  );
}
