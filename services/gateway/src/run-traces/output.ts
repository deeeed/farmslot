// ADR-039 Amendment 10: record the output a run was graded on, with its diff bytes.
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Run, RunGradedOutput } from '@farmslot/protocol';
import type { SlotVars } from '@farmslot/slot-config';

import { writeAtomicText } from '../core/atomic-json.js';
import { shellQuote } from '../core/tmux.js';
import { readSlotCommand } from '../host-services/read-command.js';
import { runEpisodeDir } from '../run-completion/run-episode.js';
import { getRun, updateRun } from '../runs/store.js';

/** Diff bytes kept per run; a larger diff keeps only its sha256 and size. */
export const GRADED_DIFF_MAX_BYTES = 32 * 1024 * 1024;
const BODY_MARKER = '--farmslot-graded-diff--';

/** `<episode store>/outputs/<run-id>/graded.diff`, kept forever beside the episode. */
export function gradedDiffFile(runId: string): string {
  if (!runId || path.basename(runId) !== runId) throw new Error(`Invalid run id: ${runId}`);
  return path.join(runEpisodeDir(), 'outputs', runId, 'graded.diff');
}

/**
 * One batched command on the slot: the head, then the diff against the dispatch head built in a
 * temporary file, its size and sha256, and its bytes when they fit. A working-tree diff stages
 * into a temporary index seeded from the slot's (so only changed files are hashed), at a fresh
 * path, so untracked files are included and the slot's own index is untouched.
 */
export function gradedDiffScript(input: {
  repo: string;
  base: string;
  source: RunGradedOutput['source'];
  ref: string | null;
}): string {
  const git = `git -C ${shellQuote(input.repo)}`;
  const diff =
    input.source === 'working-tree'
      ? [
          `cp "$(${git} rev-parse --path-format=absolute --git-path index)" "$d/index" 2>/dev/null || true`,
          `GIT_INDEX_FILE="$d/index" ${git} add -A`,
          `GIT_INDEX_FILE="$d/index" ${git} diff --cached --binary ${shellQuote(input.base)} > "$d/diff"`,
        ].join('\n')
      : `${git} diff --binary ${shellQuote(input.base)} ${shellQuote(input.ref ?? 'HEAD')} > "$d/diff"`;
  return [
    'set -e',
    'd=$(mktemp -d)',
    `trap 'rm -rf "$d"' EXIT`,
    `${git} rev-parse HEAD`,
    diff,
    `wc -c < "$d/diff" | tr -d ' '`,
    `(sha256sum "$d/diff" 2>/dev/null || shasum -a 256 "$d/diff") | cut -d' ' -f1`,
    `echo ${BODY_MARKER}`,
    `if [ "$(wc -c < "$d/diff")" -le ${GRADED_DIFF_MAX_BYTES} ]; then cat "$d/diff"; fi`,
  ].join('\n');
}

export function parseGradedDiffOutput(stdout: string) {
  const marker = stdout.indexOf(`${BODY_MARKER}\n`);
  if (marker < 0) throw new Error('graded diff output is incomplete');
  const [head, size, sha256] = stdout.slice(0, marker).trim().split('\n');
  if (!/^[0-9a-f]{40,64}$/.test(head ?? '') || !/^[0-9a-f]{64}$/.test(sha256 ?? ''))
    throw new Error('graded diff output is malformed');
  const sizeBytes = Number(size);
  const body = stdout.slice(marker + BODY_MARKER.length + 1);
  return {
    head: head!,
    sizeBytes,
    sha256: sha256!,
    body: sizeBytes <= GRADED_DIFF_MAX_BYTES ? body : null,
  };
}

/**
 * Records `gradedOutput` and `finalHead` from the slot. Advisory: it never throws, and a run that
 * already recorded a committed output keeps it.
 */
export async function recordGradedOutput(input: {
  runId: string;
  vars: SlotVars;
  source: RunGradedOutput['source'];
  ref: string | null;
}): Promise<RunGradedOutput | undefined> {
  try {
    const run = getRun(input.runId);
    const base = run && dispatchBase(run);
    if (!run || !base) return undefined;
    if (run.gradedOutput?.source === 'committed' && input.source !== 'committed')
      return run.gradedOutput;
    const result = await readSlotCommand(
      input.vars,
      gradedDiffScript({ repo: input.vars.remoteRepo, base, source: input.source, ref: input.ref }),
      { timeout: 60_000, maxBuffer: GRADED_DIFF_MAX_BYTES + 64 * 1024 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'graded diff failed');
    const parsed = parseGradedDiffOutput(result.stdout);
    let filePath: string | undefined;
    if (parsed.body !== null) {
      if (createHash('sha256').update(parsed.body).digest('hex') !== parsed.sha256)
        throw new Error('graded diff bytes do not match the sha256 the slot reported');
      filePath = gradedDiffFile(input.runId);
      await writeAtomicText(filePath, parsed.body);
    }
    const output: RunGradedOutput = {
      diffSha256: parsed.sha256,
      source: input.source,
      ref: input.source === 'working-tree' ? null : (input.ref ?? parsed.head),
      ...(filePath ? { path: path.relative(runEpisodeDir(), filePath) } : {}),
      sizeBytes: parsed.sizeBytes,
      recordedAt: new Date().toISOString(),
    };
    updateRun(input.runId, { gradedOutput: output, finalHead: parsed.head });
    return output;
  } catch (error) {
    console.warn(
      `[run-traces] ${input.runId.slice(0, 8)}: graded output not recorded: ${(error as Error).message}`,
    );
    return undefined;
  }
}

/** Records the output on the run's slot, loading its vars; advisory and never throws. */
export async function recordGradedOutputOnSlot(input: {
  runId: string;
  source: RunGradedOutput['source'];
  ref: string | null;
}): Promise<RunGradedOutput | undefined> {
  const slotId = getRun(input.runId)?.slotId;
  if (!slotId) return undefined;
  const { loadSlotVars } = await import('../core/config.js');
  const vars = await loadSlotVars(slotId).catch(() => undefined);
  return vars ? recordGradedOutput({ ...input, vars }) : undefined;
}

function dispatchBase(run: Run): string | undefined {
  return run.worktreeHeadAtDispatch ?? run.preWorkBaseSha ?? run.startRef?.resolvedSha ?? undefined;
}

/** Records the PR head a run published. */
export function recordPrHead(runId: string, prHead: string | null | undefined): void {
  if (prHead && getRun(runId)) updateRun(runId, { prHead });
}

/** Records the merge commit once the run's PR merged; one GitHub read, advisory. */
export async function recordPrMerge(runId: string, repo: string, prNumber: number): Promise<void> {
  try {
    const run = getRun(runId);
    if (!run || run.mergeSha) return;
    const { fetchGitHubPR } = await import('../external/github.js');
    const pr = await fetchGitHubPR(`${repo}#${prNumber}`);
    if (!pr.merged || !pr.mergeCommitSha) return;
    updateRun(runId, {
      mergeSha: pr.mergeCommitSha,
      ...(run.prHead ? {} : { prHead: pr.headSha }),
    });
  } catch (error) {
    console.warn(
      `[run-traces] ${runId.slice(0, 8)}: merge commit not recorded: ${(error as Error).message}`,
    );
  }
}

/** Steps whose failure is the farm's, not the agent's: an attempt that never reached the worker. */
const INFRA_STEPS = new Set(['find-slot', 'write-task', 'prepare', 'dispatch']);

/**
 * Appends the failed steps a replay is about to reset to the run's attempt log, so the failure
 * survives the replay (ADR-039 Amendment 10). Append-only.
 */
export function recordReplayedFailures(runId: string, replayedStep: string): void {
  const run = getRun(runId);
  if (!run) return;
  const failed = run.steps.filter((step) => step.status === 'failed');
  if (!failed.length) return;
  const at = new Date().toISOString();
  updateRun(runId, {
    attemptLog: [
      ...(run.attemptLog ?? []),
      ...failed.map((step) => ({
        kind: INFRA_STEPS.has(step.name) ? ('infra-failure' as const) : ('replay' as const),
        step: step.name,
        at: step.completedAt ?? at,
        ...(step.detail ? { error: step.detail } : {}),
        recovery: `replay ${replayedStep}`,
      })),
    ],
  });
}

/**
 * Records the acceptance ledger at completion, read from the retained task directory, for a run
 * whose ready gate recorded none. Advisory: a run without retained artifacts keeps it unset.
 */
export async function recordCompletionAcceptance(runId: string): Promise<void> {
  try {
    const run = getRun(runId);
    if (!run || run.completionAcceptance) return;
    if (
      run.decisions.some(
        (decision) => decision.payload?.kind === 'ready' && decision.payload.acceptanceStatus,
      )
    )
      return;
    const { retainedRunTaskDirectory } = await import('../run-completion/retained-artifacts.js');
    const { readAcceptanceStatusLedger } = await import('../tasks/acceptance-status.js');
    const { ORCHESTRATOR_LOCALITY } = await import('../core/slot-io.js');
    const ledger = await readAcceptanceStatusLedger(
      ORCHESTRATOR_LOCALITY,
      await retainedRunTaskDirectory(run),
    );
    if (ledger && getRun(runId)) updateRun(runId, { completionAcceptance: ledger });
  } catch (error) {
    console.warn(
      `[run-traces] ${runId.slice(0, 8)}: completion acceptance not recorded: ${(error as Error).message}`,
    );
  }
}
