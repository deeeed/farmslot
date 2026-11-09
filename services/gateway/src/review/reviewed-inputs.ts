// reviewed-inputs.ts — what a passing review judged, so a later change to it
// makes review run again before publication (F42 rule 3).

import { createHash } from 'node:crypto';

import type { Run, RunEngineState } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { readSlotProbe } from '../core/read-probes.js';
import { shellQuote } from '../core/tmux.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { resolveWorkerTaskDir } from './templates.js';

const EVIDENCE_MEDIA = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm'];
// Files that choose or label evidence, wherever a recipe run put them.
const EVIDENCE_INDEXES = ['evidence-manifest.json', 'latest-valid-recipe-run.json'];

/**
 * Lists HEAD, then the description, the worker report, the task's own and inherited
 * evidence manifests and every evidence media file or
 * evidence index under the task's artifacts or inherited inputs, with git blob ids.
 * Gateway-written review files are other names, so a review never changes its
 * own fingerprint. Description and report edits are tracked only for empty-fix
 * detection; the description also matches older passing fingerprints.
 */
export function reviewedInputsCommand(repo: string, taskDir: string): string {
  const artifacts = `${taskDir}/artifacts`;
  const inherited = `${taskDir}/inputs/inherited`;
  const names = [
    ...EVIDENCE_MEDIA.map((ext) => `-iname ${shellQuote(`*.${ext}`)}`),
    ...EVIDENCE_INDEXES.map((name) => `-name ${shellQuote(name)}`),
  ].join(' -o ');
  return [
    `cd ${shellQuote(repo)}`,
    'git rev-parse HEAD',
    `{ printf '%s\\n' ${shellQuote(`${artifacts}/pr-description.md`)} ${shellQuote(`${artifacts}/report.md`)} ${shellQuote(`${artifacts}/evidence-manifest.json`)} ${shellQuote(`${inherited}/evidence-manifest.json`)}; find ${shellQuote(artifacts)} ${shellQuote(inherited)} -type f \\( ${names} \\) 2>/dev/null | LC_ALL=C sort; } | while IFS= read -r f; do if [ -f "$f" ]; then printf '%s %s\\n' "$f" "$(git hash-object "$f")"; else printf '%s missing\\n' "$f"; fi; done`,
  ].join(' && ');
}

export interface ReviewedInputsFingerprint {
  /** HEAD and evidence; description and report edits never hold approval. */
  fingerprint: string;
  /** The earlier approval listing, including the description but excluding the worker report. */
  legacyFingerprint: string;
  /** All listed inputs, including the description and worker report, for empty-fix detection. */
  fixFingerprint: string;
}

/** Fingerprints of a reviewedInputsCommand listing for the task at `taskDir`. */
export function fingerprintReviewedInputs(
  listing: string,
  taskDir: string,
): ReviewedInputsFingerprint {
  const description = `${taskDir}/artifacts/pr-description.md `;
  const report = `${taskDir}/artifacts/report.md `;
  const withoutReport = listing
    .split('\n')
    .filter((line) => !line.startsWith(report))
    .join('\n');
  const withoutDescription = withoutReport
    .split('\n')
    .filter((line) => !line.startsWith(description))
    .join('\n');
  return {
    fingerprint: createHash('sha256').update(withoutDescription).digest('hex'),
    legacyFingerprint: createHash('sha256').update(withoutReport).digest('hex'),
    fixFingerprint: createHash('sha256').update(listing).digest('hex'),
  };
}

/** The fingerprints of what a reviewer judges now, or null when the slot cannot say. */
export async function readReviewedInputs(
  run: Pick<Run, 'id' | 'project' | 'taskFile' | 'slotId'>,
): Promise<ReviewedInputsFingerprint | null> {
  if (!run.slotId) return null;
  try {
    const vars = await loadSlotVars(run.slotId);
    const taskDir = await resolveWorkerTaskDir(vars, run.project, run.taskFile);
    if (!taskDir) return null;
    const result = await readSlotProbe(
      vars,
      reviewedInputsCommand(vars.remoteRepo, taskDir),
      `reviewed-inputs:${run.id}`,
      60_000,
    );
    if (result.exitCode !== 0) return null;
    return fingerprintReviewedInputs(result.stdout, taskDir);
  } catch {
    return null;
  }
}

async function patchEngineState(runId: string, patch: Partial<RunEngineState>): Promise<void> {
  const latest = getRun(runId);
  if (!latest) return;
  await persistRunNow(
    updateRun(runId, { engineState: { ...latest.engineState, ...patch } }),
    'reviewed inputs',
  );
}

/**
 * Called as a review document is written: what the reviewer is given. A review
 * recovered after a restart passes on this snapshot, not on the slot as it is
 * by then.
 */
export async function noteReviewInputsAtLaunch(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const current = await readReviewedInputs(run);
  await patchEngineState(runId, {
    reviewInputsAtLaunch: current?.fingerprint,
    reviewFixInputsAtLaunch: current?.fixFingerprint,
  });
}

/** A completed verdict records its launch inputs; issues retain the last passing baseline. */
export async function recordReviewedInputs(
  runId: string,
  verdict: 'pass' | 'issues' = 'pass',
): Promise<void> {
  const fingerprint = getRun(runId)?.engineState?.reviewInputsAtLaunch;
  if (!fingerprint) return;
  if (verdict === 'issues') {
    await markReviewedInputsRerun(runId, fingerprint);
    return;
  }
  await patchEngineState(runId, {
    reviewedInputs: { fingerprint, recordedAt: new Date().toISOString() },
  });
}

function fingerprintDiffers(current: ReviewedInputsFingerprint, recorded: string): boolean {
  return current.fingerprint !== recorded && current.legacyFingerprint !== recorded;
}

/** Read-only evidence change since the last issues result, not an older passing review. */
export async function lastIssuesReviewInputsChanged(run: Run): Promise<boolean> {
  const reviewed = run.engineState?.reviewedInputs?.rerunFor;
  if (!reviewed || reviewed !== run.engineState?.reviewInputsAtLaunch) return false;
  const current = await readReviewedInputs(run);
  return !!current && fingerprintDiffers(current, reviewed);
}

/**
 * The current fingerprint when it differs from what the last passing review
 * judged, else null. A run with no record, or a slot that cannot be read,
 * reports no change: the gate then behaves as it did before this check existed.
 * A record taken with the description in it still matches while nothing it
 * covered changed; a description edit on it reports a change once.
 */
async function changedReviewedInputs(run: Run): Promise<string | null> {
  const recorded = run.engineState?.reviewedInputs?.fingerprint;
  if (!recorded) return null;
  const current = await readReviewedInputs(run);
  if (!current) return null;
  return fingerprintDiffers(current, recorded) ? current.fingerprint : null;
}

export async function reviewedInputsChanged(run: Run): Promise<boolean> {
  return (await changedReviewedInputs(run)) !== null;
}

/**
 * The changed fingerprint when review has not yet run again for it, else
 * null. Review re-runs once per changed state: one that does not pass
 * leaves review unsatisfied at the gate instead of looping.
 */
export async function reviewedInputsAwaitingReview(run: Run): Promise<string | null> {
  const changed = await changedReviewedInputs(run);
  return changed && changed !== run.engineState?.reviewedInputs?.rerunFor ? changed : null;
}

/** Marks `fingerprint` as re-reviewed, once a review given it settled, so the gate does not re-run it again. */
export async function markReviewedInputsRerun(runId: string, fingerprint: string): Promise<void> {
  const recorded = getRun(runId)?.engineState?.reviewedInputs;
  if (!recorded || recorded.rerunFor === fingerprint) return;
  await patchEngineState(runId, { reviewedInputs: { ...recorded, rerunFor: fingerprint } });
}
