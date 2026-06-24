import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type CommentsTriageSummary,
  DEFAULT_TASK_DIR,
  Events,
  FLOW_WORKER_REPORT_ARTIFACTS,
  type RetrospectivePayload,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import {
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
} from '../core/config.js';
import { slotFileExists, slotReadFile } from '../core/slot-io.js';
import { getFamilyRuns } from '../family-observability/context.js';
import { getAllRuns, getRun, updateRun } from '../runs/store.js';

// ─── Worker report ───

export async function readWorkerReport(run: Run): Promise<string | null> {
  if (!run.taskFile) return null;
  // Per-flow artifact preference — pr-complete writes comments-report.md, review-pr
  // writes review.md, others use report.md. See FLOW_WORKER_REPORT_ARTIFACTS for the
  // canonical mapping; adding a new flow's artifact name is a one-line change there.
  const candidates = FLOW_WORKER_REPORT_ARTIFACTS[run.flowType] ?? ['report.md'];
  const taskDir = path.dirname(run.taskFile);

  for (const fileName of candidates) {
    const localPath = path.join(taskDir, 'artifacts', fileName);
    if (existsSync(localPath)) {
      const text = await readFile(localPath, 'utf-8');
      if (text.trim()) return text;
    }
  }

  // Fallback: artifacts may not be copied back yet — read from the slot directly.
  if (run.slotId) {
    try {
      const vars = await loadSlotVars(run.slotId);
      const taskRelDir = run.taskFile.includes('/tasks/')
        ? run.taskFile.split('/tasks/')[1].replace('/TASK.md', '')
        : null;
      if (taskRelDir) {
        const pv = await loadProjectVars(run.project).catch(() => null);
        const taskDirName = pv
          ? resolveProjectTaskDirName(pv.projectJson)
          : DEFAULT_TASK_DIR;
        for (const fileName of candidates) {
          const workerReport = path.join(
            vars.remoteRepo,
            taskDirName,
            taskRelDir,
            'artifacts',
            fileName,
          );
          if (await slotFileExists(vars, workerReport)) {
            const text = await slotReadFile(vars, workerReport);
            if (text.trim()) return text;
          }
        }
      }
    } catch {
      /* slot may not be accessible */
    }
  }

  return null;
}

export async function readTaskArtifactText(run: Run, fileName: string): Promise<string | null> {
  if (!run.taskFile) return null;
  const artifactPath = path.join(path.dirname(run.taskFile), 'artifacts', fileName);
  if (!existsSync(artifactPath)) return null;
  try {
    return await readFile(artifactPath, 'utf-8');
  } catch {
    return null;
  }
}

function uniqueRuns(runs: Run[], excludeIds: ReadonlySet<string> = new Set()): Run[] {
  const seen = new Set<string>(excludeIds);
  return runs.filter((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
}

async function composeFamilyLearningsForRetrospective(
  run: Run,
  rootRun: Run | null,
  familyCandidates: Run[],
  ownLearnings: string | null,
  commentsTriageSummary: CommentsTriageSummary | null,
): Promise<string | undefined> {
  const sections: string[] = [];
  const rootLearnings = rootRun
    ? (await readTaskArtifactText(rootRun, 'learnings.md'))?.trim()
    : '';
  if (rootRun && rootLearnings) {
    sections.push(
      `## Original ${rootRun.flowType} learnings (run ${rootRun.id.slice(0, 8)})\n${rootLearnings}`,
    );
  }

  const intermediateRuns = familyCandidates
    .filter((candidate) => candidate.id !== rootRun?.id && candidate.id !== run.id)
    .sort((a, b) => (a.completedAt ?? a.updatedAt).localeCompare(b.completedAt ?? b.updatedAt));
  for (const candidate of intermediateRuns) {
    const learnings = (await readTaskArtifactText(candidate, 'learnings.md'))?.trim();
    if (!learnings) continue;
    sections.push(
      `## Earlier ${candidate.flowType} learnings (run ${candidate.id.slice(0, 8)})\n${learnings}`,
    );
  }

  const own = ownLearnings?.trim();
  if (own) {
    sections.push(`## Terminal ${run.flowType} learnings (run ${run.id.slice(0, 8)})\n${own}`);
  }

  if (commentsTriageSummary && commentsTriageSummary.total > 0) {
    const paths = commentsTriageSummary.actionablePaths?.length
      ? `\npaths: ${commentsTriageSummary.actionablePaths.join(', ')}`
      : '';
    sections.push(
      `## Review comments summary\ntotal=${commentsTriageSummary.total} real=${commentsTriageSummary.real} fixed=${commentsTriageSummary.fixed} botAddressed=${commentsTriageSummary.botAddressed ?? 0} humanCommentsAddressed=${commentsTriageSummary.humanCommentsAddressed ?? 0}${paths}`,
    );
  }

  const composed = sections.join('\n\n').trim();
  return composed || undefined;
}

async function readLatestFamilyCommentsTriageSummary(
  runs: Run[],
): Promise<CommentsTriageSummary | null> {
  const ordered = [...runs].sort((a, b) =>
    (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt),
  );
  for (const candidate of ordered) {
    if (!candidate.taskFile) continue;
    const summary = await readCommentsTriageSummary(path.dirname(candidate.taskFile));
    if (summary && summary.total > 0) return summary;
  }
  return null;
}

// ─── Retrospective ───

// Per-section excerpt cap for retrospective payload (root/delta/own learnings,
// report excerpt). Used 4x — extracted to keep the limit consistent.
type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};

export function initRunCompletionRetrospective(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

const LEARNING_SUMMARY_MAX_CHARS = 1200;

interface CommentsTriageEntry {
  triage?: string;
  fixed_in_commit?: string | null;
  path?: string;
  source?: string;
  author?: string;
  source_kind?: string;
  author_login?: string;
  author_type?: string;
  review_state?: string;
  reviewer_login?: string;
  comment_id?: string | number;
  review_id?: string | number;
}

function normalizeCommentSource(entry: CommentsTriageEntry): 'bot' | 'human' | 'unknown' {
  const sourceKind = entry.source_kind ?? entry.source;
  const authorType = entry.author_type;
  if (typeof sourceKind === 'string') {
    const normalized = sourceKind.toLowerCase();
    if (normalized === 'bugbot' || normalized === 'bot' || normalized === 'ci') return 'bot';
    if (normalized === 'human') return 'human';
  }
  if (typeof authorType === 'string') {
    const normalized = authorType.toLowerCase();
    if (normalized.includes('bot')) return 'bot';
    if (normalized === 'user' || normalized === 'human') return 'human';
  }
  return 'unknown';
}

/**
 * Single source of truth for parsing `comments-triage.json` into the protocol
 * `CommentsTriageSummary` shape. Reused by family-observability (missing-data
 * gate), run-completion (composite retrospective payload), and methods/run.ts
 * (improvement-engine prompt context). Keeping one parser prevents the three
 * call sites from drifting on what counts as "actionable".
 *
 * Accepts the absolute task dir (the parent of `artifacts/`). Returns null if
 * the file is missing, malformed, or not an array.
 */
export async function readCommentsTriageSummary(
  taskDir: string,
): Promise<CommentsTriageSummary | null> {
  const text = await readTextFromArtifacts(taskDir, 'comments-triage.json');
  if (!text) return null;
  let entries: CommentsTriageEntry[];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      console.warn(
        `[run-completion] comments-triage.json at ${taskDir} is not a JSON array — treating as missing`,
      );
      return null;
    }
    // Guard against null/non-object entries so a malformed row doesn't throw
    // when callbacks dereference `.triage`.
    entries = parsed.filter((e): e is CommentsTriageEntry => e != null && typeof e === 'object');
  } catch (err) {
    // Malformed comments-triage.json — treat as missing rather than crash the
    // retrospective flow. Worker is expected to emit valid JSON; log the
    // corruption so a recurring producer-side issue is visible.
    console.warn(
      `[run-completion] malformed comments-triage.json at ${taskDir}: ${(err as Error).message}`,
    );
    return null;
  }
  const summary: CommentsTriageSummary = {
    total: entries.length,
    real: entries.filter((e) => e.triage === 'REAL').length,
    falsePositive: entries.filter((e) => e.triage === 'FALSE_POSITIVE').length,
    outOfScope: entries.filter((e) => e.triage === 'OUT_OF_SCOPE').length,
    fixed: entries.filter((e) => e.triage === 'REAL' && e.fixed_in_commit).length,
  };
  const humanReviewersRequestingChanges = new Set(
    entries
      .filter(
        (e) => normalizeCommentSource(e) === 'human' && e.review_state === 'CHANGES_REQUESTED',
      )
      .map((e) => e.reviewer_login || e.author_login || e.author)
      .filter((login): login is string => typeof login === 'string' && login.length > 0),
  );
  summary.botAddressed = entries.filter(
    (e) => e.triage === 'REAL' && e.fixed_in_commit && normalizeCommentSource(e) === 'bot',
  ).length;
  summary.humanCommentsAddressed = entries.filter(
    (e) => e.triage === 'REAL' && e.fixed_in_commit && normalizeCommentSource(e) === 'human',
  ).length;
  summary.humanReviewersRequestingChanges = humanReviewersRequestingChanges.size;
  summary.unknownSource = entries.filter((e) => normalizeCommentSource(e) === 'unknown').length;
  const paths = Array.from(
    new Set(
      entries
        .filter((e) => e.triage === 'REAL' && e.fixed_in_commit && e.path)
        .map((e) => e.path as string),
    ),
  ).slice(0, 5);
  if (paths.length) summary.actionablePaths = paths;
  return summary;
}

async function readTextFromArtifacts(taskDir: string, fileName: string): Promise<string | null> {
  const filePath = path.join(taskDir, 'artifacts', fileName);
  if (!existsSync(filePath)) return null;
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function createRetrospective(run: Run, report: string | null): Promise<void> {
  const ownLearnings = await readTaskArtifactText(run, 'learnings.md');
  const isFamilyTerminalFlow =
    Boolean(run.parentRunId) && (run.flowType === 'pr-complete' || run.flowType === 'merge-main');
  const needsFamilyScan = isFamilyTerminalFlow || run.flowType === 'pr-complete';
  let rootRun: Run | null = null;
  let commentsTriageSummary: CommentsTriageSummary | null = null;
  let familyCandidates: Run[] = [];
  let familyLearnings: string | undefined;

  if (needsFamilyScan) {
    const allRuns = getAllRuns();
    const family = getFamilyRuns(run, allRuns);
    rootRun = isFamilyTerminalFlow && family.rootRun.id !== run.id ? family.rootRun : null;
    // Capture all family runs except the current one so the supersession scan
    // below can find an existing composite retrospective on any prior run in
    // the family — root, direct parent, or sibling. getFamilyRuns excludes
    // parentRun from otherFamilyRuns, so include it explicitly; chained
    // pr-complete-on-pr-complete must still be able to supersede the parent
    // follow-up's retrospective.
    const candidatesRaw: Run[] = [
      family.rootRun,
      ...(family.parentRun ? [family.parentRun] : []),
      ...family.otherFamilyRuns,
    ];
    familyCandidates = uniqueRuns(candidatesRaw, new Set([run.id]));
    commentsTriageSummary = await readLatestFamilyCommentsTriageSummary([run, ...familyCandidates]);
    familyLearnings = isFamilyTerminalFlow
      ? await composeFamilyLearningsForRetrospective(
          run,
          rootRun,
          familyCandidates,
          ownLearnings,
          commentsTriageSummary,
        )
      : undefined;
  }

  // Standalone pr-complete runs should not spam the inbox when there is no
  // actionable learning. Family pr-complete runs still emit when the family has
  // root/intermediate learnings so the final card represents the whole family.
  if (
    run.flowType === 'pr-complete' &&
    !ownLearnings?.trim() &&
    !familyLearnings?.trim() &&
    !(commentsTriageSummary && commentsTriageSummary.real > 0)
  )
    return;
  // merge-main is only useful as a family-level terminal retrospective. If a
  // standalone merge-main somehow has no report and no family learnings, skip it.
  if (run.flowType === 'merge-main' && !familyLearnings?.trim() && !report?.trim()) return;

  // Build the new retrospective payload + decision FIRST so any IO failure
  // here aborts cleanly without leaving the root retrospective marked
  // superseded with no replacement. Atomic swap (mark root + append new +
  // single broadcast pair) only after the new decision is fully constructed.
  const inferredOutcome = inferRetrospectiveOutcome(run);
  const payload = await buildRetrospectivePayload(run, report, inferredOutcome, {
    rootRun: rootRun ?? undefined,
    deltaLearnings: isFamilyTerminalFlow ? (ownLearnings ?? undefined) : undefined,
    familyLearnings,
    commentsTriageSummary: commentsTriageSummary ?? undefined,
  });

  const summary = report
    ? report.split('\n').find((l) => l.startsWith('##') && l.toLowerCase().includes('summary'))
      ? report
          .split('\n')
          .slice(
            report
              .split('\n')
              .findIndex((l) => l.startsWith('##') && l.toLowerCase().includes('summary')) + 1,
          )
          .slice(0, 5)
          .join('\n')
          .trim()
      : `${run.flowType} run completed`
    : `${run.flowType} run completed (${inferredOutcome})`;

  const titlePrefix =
    isFamilyTerminalFlow && rootRun
      ? `Family retrospective (root ${rootRun.id.slice(0, 8)}) — ${run.ticketOrPr}`
      : `Review run ${run.id.slice(0, 8)} — ${run.ticketOrPr}`;

  // Resolve the existing family-level retrospective (without mutating yet) so
  // we can attach its id to the new decision's context for traceability. Scan
  // ALL family runs — root + siblings — because an earlier actionable
  // pr-complete may have already produced a composite retrospective on a
  // sibling run. Without this, a second pr-complete on the same family would
  // leave the prior follow-up's card unresolved and produce duplicate inbox
  // entries for one family.
  let supersedeRetroId: string | null = null;
  let supersedeRunStored: Run | null = null;
  for (const candidate of familyCandidates) {
    const stored = getRun(candidate.id) ?? candidate;
    const pendingRetro = stored.decisions.find((d) => d.type === 'retrospective' && !d.resolvedAt);
    if (pendingRetro) {
      supersedeRunStored = stored;
      supersedeRetroId = pendingRetro.id;
      break;
    }
  }

  const decision: RunDecision = {
    id: randomUUID(),
    type: 'retrospective',
    title: titlePrefix,
    description: summary,
    actions: [
      { id: 'accept', label: 'Accept for Learning', style: 'primary' },
      { id: 'rework', label: 'Reject Learning', style: 'secondary' },
      { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
    ],
    createdAt: new Date().toISOString(),
    payload,
    ...(supersedeRetroId && supersedeRunStored
      ? {
          context: {
            supersededRootRetroId: supersedeRetroId,
            supersededRootRunId: supersedeRunStored.id,
          },
        }
      : {}),
  };

  const current = getRun(run.id);
  if (!current) return;

  // Atomic swap — must stay synchronous through the broadcast pair below.
  // No `await` allowed here: an interleaved microtask lets a concurrent
  // createRetrospective observe partial state and the race-loser bail can't
  // recover. Re-check the target is still pending before mutating; another
  // run may have superseded it during our payload build.
  let supersededAfterRecheck = false;
  if (supersedeRunStored && supersedeRetroId) {
    const fresh = getRun(supersedeRunStored.id);
    const target = fresh?.decisions.find((d) => d.id === supersedeRetroId && !d.resolvedAt);
    if (fresh && target) {
      target.resolvedAt = new Date().toISOString();
      target.resolvedAction = 'superseded';
      updateRun(fresh.id, { decisions: fresh.decisions });
      supersededAfterRecheck = true;
    }
  }
  // Race-loser bail: a concurrent terminal follow-up may have persisted its own
  // retrospective between our up-front scan and the atomic swap above. Bail
  // so the family ends up with one card, not two.
  if (!supersededAfterRecheck && needsFamilyScan) {
    const winnerExists = familyCandidates.some((c) => {
      const stored = getRun(c.id);
      return stored?.decisions.some((d) => d.type === 'retrospective' && !d.resolvedAt);
    });
    if (winnerExists) {
      console.log(
        `[run-completion] race-loser bail: family ${(run.familyId ?? run.id).slice(0, 8)} already has a pending retro from a sibling pr-complete`,
      );
      return;
    }
  }
  // Clear the breadcrumb when we didn't actually supersede anything — keeps
  // the new decision's lineage honest.
  if (!supersededAfterRecheck && decision.context) {
    delete (decision.context as Record<string, unknown>).supersededRootRetroId;
    delete (decision.context as Record<string, unknown>).supersededRootRunId;
  }
  current.decisions.push(decision);
  updateRun(run.id, { decisions: current.decisions });

  // Emit broadcasts after persistence so subscribers always see the new
  // decision land at the same time as (or after) the supersession of the
  // prior family retrospective.
  if (supersededAfterRecheck && supersedeRunStored && supersedeRetroId) {
    broadcastFn(Events.RUN_DECISION_RESOLVED, {
      runId: supersedeRunStored.id,
      decisionId: supersedeRetroId,
      actionId: 'superseded',
    });
    // Mirror DECISION_RESOLVED so file-bus subscribers (legacy file-based
    // decision listeners + the inbox path) drop the superseded card too;
    // RUN_DECISION_RESOLVED alone misses subscribers that only listen on
    // the file-bus event.
    broadcastFn(Events.DECISION_RESOLVED, { id: supersedeRetroId });
    broadcastFn(Events.RUN_UPDATED, { run: getRun(supersedeRunStored.id) });
  }
  broadcastFn(Events.RUN_DECISION_NEW, { runId: run.id, decision, slotId: run.slotId });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(run.id) });
}

/** Convenience wrapper: creates a retrospective by runId (reads report internally). */
export async function createRetrospectiveForRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const report = await readWorkerReport(run);
  await createRetrospective(run, report);
}

export function inferRetrospectiveOutcome(
  run: Run,
): 'success' | 'failure' | 'partial' | 'cancelled' | 'unknown' {
  if (run.metrics.outcome) return run.metrics.outcome;
  if (run.status === 'cancelled') return 'cancelled';
  if (run.steps.some((step) => step.status === 'failed')) return 'failure';

  const ciWatchStep = run.steps.find((step) => step.name === 'ci-watch');
  const ciResult =
    typeof ciWatchStep?.outputs?.result === 'string' ? ciWatchStep.outputs.result : null;
  if (ciResult === 'passed') return 'success';
  if (ciResult === 'aborted') return 'cancelled';
  if (
    ciResult === 'failed' ||
    ciResult === 'blocked' ||
    ciResult === 'comments' ||
    ciResult === 'timeout'
  )
    return 'partial';

  const hasIncompleteStep = run.steps.some(
    (step) => step.status !== 'done' && step.status !== 'skipped',
  );
  if (!hasIncompleteStep) return 'success';

  return 'unknown';
}

export async function buildRetrospectivePayload(
  run: Run,
  report: string | null,
  outcome = inferRetrospectiveOutcome(run),
  context?: {
    rootRun?: Run;
    deltaLearnings?: string;
    familyLearnings?: string;
    commentsTriageSummary?: CommentsTriageSummary;
  },
): Promise<RetrospectivePayload> {
  const ownLearnings = await readTaskArtifactText(run, 'learnings.md');
  const selfReviewStep = run.steps.find((step) => step.name === 'self-review');
  const selfReviewOutputs = selfReviewStep?.outputs as
    | {
        verdict?: string;
        skipped?: boolean;
        issues?: Array<{ file?: string; description?: string }>;
      }
    | undefined;
  const selfReviewVerdict =
    selfReviewOutputs?.verdict ?? (selfReviewOutputs?.skipped ? 'skipped' : undefined);
  const selfReviewSummary = selfReviewOutputs?.issues?.length
    ? selfReviewOutputs.issues
        .map((issue) => `${issue.file ?? 'unknown'}: ${issue.description ?? 'issue'}`)
        .slice(0, 4)
        .join('; ')
    : undefined;

  const ciWatchStep = run.steps.find((step) => step.name === 'ci-watch');
  const ciResult =
    typeof ciWatchStep?.outputs?.result === 'string' ? ciWatchStep.outputs.result : undefined;
  const checkSummary = ciWatchStep?.outputs?.checkSummary as
    | { passed?: number; failed?: number; pending?: number; total?: number }
    | undefined;

  const rootLearnings = context?.rootRun
    ? (await readTaskArtifactText(context.rootRun, 'learnings.md'))
        ?.trim()
        ?.slice(0, LEARNING_SUMMARY_MAX_CHARS)
    : undefined;
  const deltaLearnings = context?.deltaLearnings?.trim()?.slice(0, LEARNING_SUMMARY_MAX_CHARS);

  // Legacy single-string consumer. For family-terminal retros this is the
  // whole family signal (root + intermediate follow-ups + terminal run +
  // comments triage) so accept/improvement analysis sees the same scope the UI
  // card describes.
  const composedWorkerLearnings =
    context?.familyLearnings?.trim().slice(0, LEARNING_SUMMARY_MAX_CHARS) ??
    (rootLearnings && deltaLearnings
      ? `## Original fix-bug learnings\n${rootLearnings}\n\n## Reviewer-driven delta\n${deltaLearnings}`
      : ownLearnings?.trim().slice(0, LEARNING_SUMMARY_MAX_CHARS));

  return {
    kind: 'retrospective',
    outcome,
    whatThisIs: context?.rootRun
      ? 'Family-level retrospective. It combines the root run, follow-up learnings, review-comment triage, and terminal PR outcome; "Accept for Learning" feeds the combined content into the improvement engine.'
      : 'Completed runs create a retrospective decision so you can decide whether this run should feed the self-improvement loop.',
    ...(selfReviewVerdict ? { selfReviewVerdict } : {}),
    ...(selfReviewSummary ? { selfReviewSummary } : {}),
    ...(composedWorkerLearnings ? { workerLearnings: composedWorkerLearnings } : {}),
    ...(rootLearnings ? { rootLearnings } : {}),
    ...(deltaLearnings ? { deltaLearnings } : {}),
    ...(context?.rootRun ? { rootRunId: context.rootRun.id } : {}),
    ...(context?.commentsTriageSummary
      ? { commentsTriageSummary: context.commentsTriageSummary }
      : {}),
    ...(report?.trim()
      ? { reportExcerpt: report.trim().slice(0, LEARNING_SUMMARY_MAX_CHARS) }
      : {}),
    ...(ciWatchStep
      ? {
          ciWatch: {
            ...(ciResult ? { result: ciResult } : {}),
            passed: checkSummary?.passed,
            failed: checkSummary?.failed,
            pending: checkSummary?.pending,
            total: checkSummary?.total,
          },
        }
      : {}),
    actionEffects: [
      {
        actionId: 'accept',
        summary: context?.rootRun
          ? 'Triggers template-improvement analysis on the combined family learnings. A separate improvement decision appears once the LLM analysis completes.'
          : 'Triggers template-improvement analysis. If the system finds a concrete improvement, a separate improvement decision appears later with Apply/Dismiss actions.',
      },
      {
        actionId: 'rework',
        summary:
          'Rejects this run as learning input. It does not reopen the run or dispatch follow-up work.',
      },
      {
        actionId: 'dismiss',
        summary: 'Hides this retrospective without triggering improvement analysis.',
      },
    ],
  };
}
