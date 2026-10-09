// reviewed-inputs.ts — what a passing review judged, so a later change to it
// makes self-review run again before publication (F42 rule 3).

import { createHash } from 'node:crypto';

import type { Run, RunEngineState } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { resolveWorkerTaskDir } from './templates.js';

const EVIDENCE_MEDIA = ['png', 'jpg', 'jpeg', 'gif', 'mp4', 'mov', 'webm'];
// Files that choose or label evidence, wherever a recipe run put them.
const EVIDENCE_INDEXES = ['evidence-manifest.json', 'latest-valid-recipe-run.json'];

/**
 * Lists HEAD, then the description, the evidence manifests (the task's own and
 * the one inherited from an upstream run) and every evidence media file or
 * evidence index under the task's artifacts or inherited inputs, with git blob ids.
 * Gateway-written review files are other names, so a review never changes its
 * own fingerprint. The description is listed only so a fingerprint recorded
 * before it was left out can still be matched (see fingerprintReviewedInputs).
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
    `{ printf '%s\\n' ${shellQuote(`${artifacts}/pr-description.md`)} ${shellQuote(`${artifacts}/evidence-manifest.json`)} ${shellQuote(`${inherited}/evidence-manifest.json`)}; find ${shellQuote(artifacts)} ${shellQuote(inherited)} -type f \\( ${names} \\) 2>/dev/null | LC_ALL=C sort; } | while IFS= read -r f; do if [ -f "$f" ]; then printf '%s %s\\n' "$f" "$(git hash-object "$f")"; else printf '%s missing\\n' "$f"; fi; done`,
  ].join(' && ');
}

export interface ReviewedInputsFingerprint {
  /** HEAD and evidence; the description is left out, so editing it never holds approval. */
  fingerprint: string;
  /** The earlier fingerprint, description included, that runs recorded before. */
  legacyFingerprint: string;
}

/** Fingerprints of a reviewedInputsCommand listing for the task at `taskDir`. */
export function fingerprintReviewedInputs(
  listing: string,
  taskDir: string,
): ReviewedInputsFingerprint {
  const description = `${taskDir}/artifacts/pr-description.md `;
  const withoutDescription = listing
    .split('\n')
    .filter((line) => !line.startsWith(description))
    .join('\n');
  return {
    fingerprint: createHash('sha256').update(withoutDescription).digest('hex'),
    legacyFingerprint: createHash('sha256').update(listing).digest('hex'),
  };
}

/** The fingerprints of what a reviewer judges now, or null when the slot cannot say. */
export async function readReviewedInputs(
  run: Pick<Run, 'project' | 'taskFile' | 'slotId'>,
): Promise<ReviewedInputsFingerprint | null> {
  if (!run.slotId) return null;
  try {
    const vars = await loadSlotVars(run.slotId);
    const taskDir = await resolveWorkerTaskDir(vars, run.project, run.taskFile);
    if (!taskDir) return null;
    const result = await execOnSlot(vars, reviewedInputsCommand(vars.remoteRepo, taskDir), {
      timeout: 60_000,
    });
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
  await patchEngineState(runId, { reviewInputsAtLaunch: current?.fingerprint });
}

/** Called when a review passes: what it was given is now what was reviewed. */
export async function recordReviewedInputs(runId: string): Promise<void> {
  const fingerprint = getRun(runId)?.engineState?.reviewInputsAtLaunch;
  if (!fingerprint) return;
  await patchEngineState(runId, {
    reviewedInputs: { fingerprint, recordedAt: new Date().toISOString() },
  });
}

/**
 * The current fingerprint when it differs from what the last passing review
 * judged, else null. A run with no record, or a slot that cannot be read,
 * reports no change: the gate then behaves as it did before this check existed.
 * A record taken with the description in it still matches while nothing it
 * covered changed.
 */
async function changedReviewedInputs(run: Run): Promise<string | null> {
  const recorded = run.engineState?.reviewedInputs?.fingerprint;
  if (!recorded) return null;
  const current = await readReviewedInputs(run);
  if (!current) return null;
  return current.fingerprint !== recorded && current.legacyFingerprint !== recorded
    ? current.fingerprint
    : null;
}

export async function reviewedInputsChanged(run: Run): Promise<boolean> {
  return (await changedReviewedInputs(run)) !== null;
}

/**
 * The changed fingerprint when self-review has not yet run again for it, else
 * null. Self-review re-runs once per changed state: one that does not pass
 * leaves review unsatisfied at the gate instead of looping.
 */
export async function reviewedInputsAwaitingReview(run: Run): Promise<string | null> {
  const changed = await changedReviewedInputs(run);
  return changed && changed !== run.engineState?.reviewedInputs?.rerunFor ? changed : null;
}

/** Marks `fingerprint` as re-reviewed, once a review given it settled, so the gate does not re-run it again. */
export async function markReviewedInputsRerun(runId: string, fingerprint: string): Promise<void> {
  const recorded = getRun(runId)?.engineState?.reviewedInputs;
  if (!recorded) return;
  await patchEngineState(runId, { reviewedInputs: { ...recorded, rerunFor: fingerprint } });
}
