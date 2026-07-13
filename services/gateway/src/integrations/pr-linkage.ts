// pr-linkage.ts — Unified PR-number discovery + persistence.
// Replaces duplicated findPRNumber / findRunPRNumber helpers and adds structured
// logging + retry on the gh-list fallback that silently failed on PROJ-2947.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { Events, type Run } from '@farmslot/protocol';

import { isFollowUpFlow } from '../family-observability/context.js';
import { refreshRunLinks } from '../run-engine/run-links.js';
import { getRun, updateRun } from '../runs/store.js';

import { getBinding, invalidateBinding, setBinding } from './github-bindings-cache.js';
import { ghRequest } from './github-client.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};

export function initPrLinkage(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

// Delays between the 4 attempts: 0s, 5s, 20s, 65s cumulative.
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

export async function findPRNumber(
  run: Run,
  ciRepo: string,
  options?: { noRetry?: boolean },
): Promise<number | null> {
  // 1. ticketOrPr may encode the PR number. For follow-up flows
  //    (review-pr / pr-complete / merge-main) the dispatch validator guarantees
  //    it's a PR ref — trust it directly. For fix-bug / new-feature / dev the
  //    same `owner/repo#N` shape can come from a GitHub issue URL (see
  //    normalizeTicketRef), so we verify via `gh api /repos/.../pulls/N`
  //    before treating the number as a PR.
  const ref = run.ticketOrPr.match(/^([^/#\s]+\/[^/#\s]+)#(\d+)$/);
  if (ref) {
    const [, refRepo, refNumStr] = ref;
    const refNum = parseInt(refNumStr, 10);
    if (isFollowUpFlow(run.flowType)) return refNum;
    if (refRepo === ciRepo) {
      try {
        const verify = await ghRequest([
          'api',
          `repos/${refRepo}/pulls/${refNum}`,
          '--jq',
          '.number',
        ]);
        if (verify.stdout.trim() === String(refNum)) return refNum;
      } catch (err) {
        console.warn(
          `[pr-linkage] gh api verify failed runId=${run.id.slice(0, 8)} pr=${refNum}: ${(err as Error).message.slice(0, 200)}`,
        );
      }
    }
  }

  // 2. Worker-written TASK.md marker.
  if (run.taskFile && existsSync(run.taskFile)) {
    try {
      const content = await readFile(run.taskFile, 'utf-8');
      const m = content.match(/PR_NUMBER:\s*(\d+)/);
      if (m) return parseInt(m[1], 10);
    } catch (err) {
      console.warn(
        `[pr-linkage] TASK.md read failed runId=${run.id.slice(0, 8)}: ${(err as Error).message}`,
      );
    }
  }

  // 3. gh pr list --head <branch> with exponential backoff (4 attempts, 5s/15s/45s).
  if (!run.branch) {
    console.warn(`[pr-linkage] findPRNumber miss runId=${run.id.slice(0, 8)} branch=<empty>`);
    return null;
  }

  // Short-circuit via disk-backed bindings cache (survives gateway restart).
  // Branch names are deterministic (buildSmartBranch), so a reused branch can
  // keep pointing at an old merged/closed PR. Revalidate before trusting.
  const cached = getBinding(run.branch, ciRepo);
  if (cached !== null) {
    try {
      const verify = await ghRequest([
        'api',
        `repos/${ciRepo}/pulls/${cached}`,
        '--jq',
        '{state:.state,head:.head.ref}',
      ]);
      const parsed = JSON.parse(verify.stdout || '{}') as { state?: string; head?: string };
      if (parsed.state === 'open' && parsed.head === run.branch) return cached;
      console.log(
        `[pr-linkage] invalidating stale cache runId=${run.id.slice(0, 8)} branch=${run.branch} prNumber=${cached} state=${parsed.state ?? '?'} head=${parsed.head ?? '?'}`,
      );
      invalidateBinding(run.branch, ciRepo);
    } catch (err) {
      console.warn(
        `[pr-linkage] gh api verify cached PR #${cached} failed runId=${run.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
      );
      invalidateBinding(run.branch, ciRepo);
    }
  }

  const totalAttempts = options?.noRetry ? 1 : RETRY_DELAYS_MS.length + 1;
  const listArgs = [
    'pr',
    'list',
    '--repo',
    ciRepo,
    '--head',
    run.branch,
    '--json',
    'number',
    '--limit',
    '1',
  ];
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
    // Retries force-refresh so a negative cache hit doesn't poison the retry window.
    const force = attempt > 0;
    let stdout: string;
    try {
      const result = await ghRequest(listArgs, { force });
      stdout = result.stdout;
    } catch (err) {
      console.warn(
        `[pr-linkage] gh pr list attempt ${attempt + 1}/${totalAttempts} failed runId=${run.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
      );
      continue;
    }
    try {
      const prs = JSON.parse(stdout || '[]') as Array<{ number: number }>;
      if (prs.length > 0) {
        setBinding(run.branch, ciRepo, prs[0].number);
        return prs[0].number;
      }
    } catch (err) {
      console.warn(
        `[pr-linkage] gh pr list attempt ${attempt + 1}/${totalAttempts} parse failed runId=${run.id.slice(0, 8)}: ${(err as Error).message}`,
      );
    }
  }
  // Open-PR search exhausted: the PR may have merged (or been closed) before
  // linkage ran — e.g. an operator merged out-of-band while the run sat at a
  // gate. Fall back to all states once so recovery paths can still link it.
  try {
    const { stdout } = await ghRequest([...listArgs, '--state', 'all'], { force: true });
    const prs = JSON.parse(stdout || '[]') as Array<{ number: number }>;
    if (prs.length > 0) {
      setBinding(run.branch, ciRepo, prs[0].number);
      return prs[0].number;
    }
  } catch (err) {
    console.warn(
      `[pr-linkage] gh pr list --state all fallback failed runId=${run.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
    );
  }
  console.warn(`[pr-linkage] findPRNumber miss runId=${run.id.slice(0, 8)} branch=${run.branch}`);
  return null;
}

/**
 * One-shot probe for a MERGED PR on the run's branch. Used by the publication
 * gate to detect out-of-band merges (work shipped while the run sat at the
 * gate) so the operator can close-as-shipped instead of re-reviewing.
 */
const MERGED_PR_PROBE_TIMEOUT_MS = 15_000;

export async function findMergedPRNumber(run: Run, ciRepo: string): Promise<number | null> {
  if (!run.branch) return null;
  try {
    const { stdout } = await withProbeTimeout(
      ghRequest(
        [
          'pr',
          'list',
          '--repo',
          ciRepo,
          '--head',
          run.branch,
          '--state',
          'merged',
          '--json',
          'number',
          '--limit',
          '1',
        ],
        { force: true },
      ),
    );
    const prs = JSON.parse(stdout || '[]') as Array<{ number: number }>;
    return prs.length > 0 ? prs[0].number : null;
  } catch (err) {
    console.warn(
      `[pr-linkage] merged-PR probe failed runId=${run.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

function withProbeTimeout<T>(probe: Promise<T>): Promise<T> {
  return Promise.race([
    probe,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`merged-PR probe timed out after ${MERGED_PR_PROBE_TIMEOUT_MS}ms`)),
        MERGED_PR_PROBE_TIMEOUT_MS,
      ).unref?.(),
    ),
  ]);
}

export async function persistRunPrNumber(runId: string, prNumber: number): Promise<void> {
  const current = getRun(runId);
  if (!current) return;
  if (current.prNumber === prNumber) return;
  updateRun(runId, { prNumber });
  // Recompute external links (PR / Issue) — completion may have saved
  // links before the PR existed, so the stale array would hide the new
  // linkage from the UI until the next ticketData change.
  await refreshRunLinks(runId);
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
  console.log(`[pr-linkage] linked run ${runId.slice(0, 8)} -> PR #${prNumber}`);
}
