// reviewed-inputs.ts — what a passing review judged, so a later change to it
// makes self-review run again before publication (F42 rule 3).

import { createHash } from 'node:crypto';

import type { Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { resolveWorkerTaskDir } from './templates.js';

const EVIDENCE_MEDIA = ['png', 'jpg', 'jpeg', 'gif', 'mp4', 'mov', 'webm'];

/**
 * Lists HEAD, then the description, the evidence manifest and every evidence
 * media file under the task's artifacts with its git blob id. Gateway-written
 * review files are text, so a review never changes its own fingerprint.
 */
export function reviewedInputsCommand(repo: string, taskDir: string): string {
  const artifacts = `${taskDir}/artifacts`;
  const media = EVIDENCE_MEDIA.map((ext) => `-iname ${shellQuote(`*.${ext}`)}`).join(' -o ');
  return [
    `cd ${shellQuote(repo)}`,
    'git rev-parse HEAD',
    `{ printf '%s\\n' ${shellQuote(`${artifacts}/pr-description.md`)} ${shellQuote(`${artifacts}/evidence-manifest.json`)}; find ${shellQuote(artifacts)} -type f \\( ${media} \\) 2>/dev/null | LC_ALL=C sort; } | while IFS= read -r f; do if [ -f "$f" ]; then printf '%s %s\\n' "$f" "$(git hash-object "$f")"; else printf '%s missing\\n' "$f"; fi; done`,
  ].join(' && ');
}

/** The fingerprint of what a reviewer judges now, or null when the slot cannot say. */
export async function readReviewedInputs(
  run: Pick<Run, 'project' | 'taskFile' | 'slotId'>,
): Promise<string | null> {
  if (!run.slotId) return null;
  try {
    const vars = await loadSlotVars(run.slotId);
    const taskDir = await resolveWorkerTaskDir(vars, run.project, run.taskFile);
    if (!taskDir) return null;
    const result = await execOnSlot(vars, reviewedInputsCommand(vars.remoteRepo, taskDir), {
      timeout: 60_000,
    });
    if (result.exitCode !== 0) return null;
    return createHash('sha256').update(result.stdout).digest('hex');
  } catch {
    return null;
  }
}

/** Called when a review passes: from now on, this is what was reviewed. */
export async function recordReviewedInputs(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const fingerprint = await readReviewedInputs(run);
  if (!fingerprint) return;
  const latest = getRun(runId)!;
  await persistRunNow(
    updateRun(runId, {
      engineState: {
        ...latest.engineState,
        reviewedInputs: { fingerprint, recordedAt: new Date().toISOString() },
      },
    }),
    'reviewed inputs',
  );
}

/**
 * True when the description, evidence or HEAD differ from what the last passing
 * review judged. A run with no record, or a slot that cannot be read, reports
 * no change: the gate then behaves as it did before this check existed.
 */
export async function reviewedInputsChanged(run: Run): Promise<boolean> {
  const recorded = run.engineState?.reviewedInputs?.fingerprint;
  if (!recorded) return false;
  const current = await readReviewedInputs(run);
  return current !== null && current !== recorded;
}
