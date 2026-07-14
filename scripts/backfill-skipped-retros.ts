#!/usr/bin/env -S yarn exec tsx
import path from 'node:path';

import type { Run } from '@farmslot/protocol';

import {
  createRetrospectiveForRun,
  readCommentsTriageSummary,
  readTaskArtifactText,
} from '../services/gateway/src/run-completion/retrospective.js';
import { getAllRuns, loadAllRuns } from '../services/gateway/src/runs/store.js';

interface Args {
  dryRun: boolean;
  includeEval: boolean;
  since: string;
  limit: number | null;
}

interface Candidate {
  familyId: string;
  terminalRun: Run;
  reason: string;
  familyRunCount: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    includeEval: false,
    since: '2026-05-15T00:00:00.000Z',
    limit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--include-eval') {
      args.includeEval = true;
    } else if (arg === '--since') {
      const value = argv[++i];
      if (!value) throw new Error('--since requires an ISO date');
      args.since = value.includes('T') ? value : `${value}T00:00:00.000Z`;
    } else if (arg === '--limit') {
      const value = argv[++i];
      if (!value || !Number.isFinite(Number(value))) throw new Error('--limit requires a number');
      args.limit = Number(value);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: scripts/backfill-skipped-retros.ts [--dry-run] [--since YYYY-MM-DD] [--limit N] [--include-eval]

Creates missing family-level retrospective decisions for terminal completed runs
that have learnings/review-comment signal but no pending retrospective.

Default --since is 2026-05-15, the regression window where human-gate flows
stopped producing terminal retrospectives. EVAL-* runs are skipped unless
--include-eval is provided.`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function familyKey(run: Run): string {
  return run.familyId || run.id;
}

function sortByTerminalTimeDesc(a: Run, b: Run): number {
  return (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt);
}

function terminalRank(run: Run): number {
  if (run.flowType === 'update-branch') return 3;
  if (run.flowType === 'pr-complete') return 2;
  if (run.flowType === 'fix-bug' || run.flowType === 'dev') return 1;
  return 0;
}

function chooseTerminalRun(runs: Run[]): Run | null {
  const doneRuns = runs.filter((run) => run.status === 'done');
  if (doneRuns.length === 0) return null;
  return [...doneRuns].sort((a, b) => {
    const rankDiff = terminalRank(b) - terminalRank(a);
    if (rankDiff !== 0) return rankDiff;
    return sortByTerminalTimeDesc(a, b);
  })[0];
}

function isEvalFamily(runs: Run[]): boolean {
  return runs.some((run) => run.lane === 'validation' || /^EVAL-/i.test(run.ticketOrPr));
}

function hasPendingRetro(runs: Run[]): boolean {
  return runs.some((run) =>
    run.decisions.some((decision) => decision.type === 'retrospective' && !decision.resolvedAt),
  );
}

async function familySignal(runs: Run[]): Promise<string | null> {
  for (const run of runs) {
    const learnings = (await readTaskArtifactText(run, 'learnings.md'))?.trim();
    if (learnings) return 'learnings.md';
  }
  for (const run of runs) {
    if (!run.taskFile) continue;
    const triage = await readCommentsTriageSummary(path.dirname(run.taskFile));
    if (triage && triage.real > 0) {
      return `comments-triage total=${triage.total} real=${triage.real} fixed=${triage.fixed}`;
    }
  }
  return null;
}

async function findCandidates(args: Args): Promise<Candidate[]> {
  const sinceMs = Date.parse(args.since);
  if (!Number.isFinite(sinceMs)) throw new Error(`invalid --since date: ${args.since}`);

  const groups = new Map<string, Run[]>();
  for (const run of getAllRuns()) {
    const key = familyKey(run);
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }

  const candidates: Candidate[] = [];
  for (const [familyId, runs] of groups) {
    if (!args.includeEval && isEvalFamily(runs)) continue;
    if (hasPendingRetro(runs)) continue;
    const terminalRun = chooseTerminalRun(runs);
    if (!terminalRun) continue;
    const terminalMs = Date.parse(terminalRun.completedAt ?? terminalRun.updatedAt);
    if (!Number.isFinite(terminalMs) || terminalMs < sinceMs) continue;

    const newestRetroCreatedAt = runs
      .flatMap((run) => run.decisions.filter((decision) => decision.type === 'retrospective'))
      .map((decision) => Date.parse(decision.createdAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    if (newestRetroCreatedAt && newestRetroCreatedAt >= terminalMs) continue;

    const shouldUseFamilySignal =
      Boolean(terminalRun.parentRunId) ||
      terminalRun.flowType === 'pr-complete' ||
      terminalRun.flowType === 'update-branch';
    const reason = await familySignal(shouldUseFamilySignal ? runs : [terminalRun]);
    if (!reason) continue;
    candidates.push({ familyId, terminalRun, reason, familyRunCount: runs.length });
  }

  const ordered = candidates.sort((a, b) => sortByTerminalTimeDesc(a.terminalRun, b.terminalRun));
  return args.limit == null ? ordered : ordered.slice(0, args.limit);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await loadAllRuns();
  const candidates = await findCandidates(args);

  console.log(
    `${args.dryRun ? 'would backfill' : 'backfilling'} ${candidates.length} skipped retrospective(s) since ${args.since}`,
  );
  for (const candidate of candidates) {
    const run = candidate.terminalRun;
    console.log(
      `${args.dryRun ? 'DRY' : 'CREATE'} family=${candidate.familyId.slice(0, 8)} terminal=${run.id.slice(0, 8)} flow=${run.flowType} project=${run.project} ticket=${run.ticketOrPr} runs=${candidate.familyRunCount} reason=${candidate.reason}`,
    );
    if (!args.dryRun) await createRetrospectiveForRun(run.id);
  }

  // updateRun() persists asynchronously; give the background writes a short
  // drain window before the one-shot script exits.
  if (!args.dryRun && candidates.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
