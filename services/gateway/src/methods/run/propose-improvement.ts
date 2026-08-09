import path from 'node:path';

import {
  Events,
  type ImprovementDiffPayload,
  type Run,
  type RunProposeImprovementParams,
  type RunProposeImprovementResult,
} from '@farmslot/protocol';

import { getFamilyRuns } from '../../family-observability/context.js';
import { readCommentsTriageSummary } from '../../run-completion/orchestrator.js';
import { getAllRuns, getRun, persistRunNow, updateRun } from '../../runs/store.js';

type Emit = (event: string, payload: unknown) => void;

async function readRunLearnings(run: Run): Promise<string> {
  if (!run.taskFile) return '';
  const { readFile } = await import('node:fs/promises');
  const taskDir = path.dirname(run.taskFile);
  const learningsPath = path.join(taskDir, 'artifacts', 'learnings.md');
  return readFile(learningsPath, 'utf-8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return '';
    // Permission/IO failure on a learnings.md that DOES exist — log so the
    // improvement engine doesn't silently see "no learnings" when the real
    // cause is a filesystem error.
    console.warn(`[improvement] readRunLearnings ${learningsPath}: ${err.message}`);
    return '';
  });
}

/**
 * LLM input is uncapped on purpose — the inbox payload's rootLearnings /
 * deltaLearnings are separately truncated to LEARNING_SUMMARY_MAX_CHARS for
 * compact display.
 */
async function composeFamilyLearnings(run: Run): Promise<string> {
  const ownLearnings = (await readRunLearnings(run)).trim();

  if (!run.parentRunId) return ownLearnings;

  const allRuns = getAllRuns();
  const family = getFamilyRuns(run, allRuns);
  if (family.rootRun.id === run.id) {
    console.warn(
      `[improvement] family root walk returned self for non-root run ${run.id.slice(0, 8)} (parentRunId=${run.parentRunId} familyId=${run.familyId}); analysis will use own learnings only`,
    );
    return ownLearnings;
  }

  const rootLearnings = (await readRunLearnings(family.rootRun)).trim();
  const triage = run.taskFile ? await readCommentsTriageSummary(path.dirname(run.taskFile)) : null;

  // Walk parentRunId up to root so chained pr-completes (A→B→C) keep B's
  // reviewer-driven learnings. `seen` guards against cyclic pointers, the
  // hop cap is belt-and-suspenders against pathological families.
  const MAX_FAMILY_HOPS = 32;
  const intermediates: Run[] = [];
  const runById = new Map(allRuns.map((r) => [r.id, r]));
  const seen = new Set<string>([run.id, family.rootRun.id]);
  let cursor: Run | null = run.parentRunId ? (runById.get(run.parentRunId) ?? null) : null;
  let hops = 0;
  while (
    cursor &&
    cursor.id !== family.rootRun.id &&
    !seen.has(cursor.id) &&
    hops < MAX_FAMILY_HOPS
  ) {
    seen.add(cursor.id);
    intermediates.push(cursor);
    cursor = cursor.parentRunId ? (runById.get(cursor.parentRunId) ?? null) : null;
    hops += 1;
  }
  // Reverse leaf-to-root → chronological for the LLM.
  intermediates.reverse();
  const interLearningsList = await Promise.all(
    intermediates.map((r) => readRunLearnings(r).then((s) => s.trim())),
  );

  const sections: string[] = [];
  if (rootLearnings) {
    sections.push(
      `## Original fix-bug learnings (run ${family.rootRun.id.slice(0, 8)})\n${rootLearnings}`,
    );
  }
  intermediates.forEach((inter, i) => {
    const interLearnings = interLearningsList[i];
    if (interLearnings) {
      sections.push(`## Earlier reviewer round (run ${inter.id.slice(0, 8)})\n${interLearnings}`);
    }
  });
  if (ownLearnings) {
    sections.push(`## Reviewer-driven delta (run ${run.id.slice(0, 8)})\n${ownLearnings}`);
  }
  if (triage && triage.total > 0) {
    const paths = triage.actionablePaths ?? [];
    const pathsLine = paths.length ? `\npaths: ${paths.join(', ')}` : '';
    sections.push(
      `## Reviewer comments summary\ntotal=${triage.total} real=${triage.real} fixed=${triage.fixed}${pathsLine}`,
    );
  }
  return sections.join('\n\n');
}

/**
 * MANUAL-000075: every improvement analysis first routes the learnings through
 * the system/domain classifier. SYSTEM entries continue into the improvement
 * engine (projects/<project>/ applier); DOMAIN entries and holds surface as a
 * separate human-gated learnings-draft card. When nothing classifies system,
 * the improvement placeholder terminalizes instead of analyzing noise.
 */
async function routeThenAnalyze(
  runId: string,
  run: Run,
  learnings: string,
  placeholderId: string,
  analyze: ImprovementAnalyzer,
  rationale?: string,
): Promise<void> {
  const router = await import('../../intelligence/learnings-router.js');
  const engine = await import('../../intelligence/improvement-engine.js');
  const routed = await router.routeLearnings(run.project, learnings);
  try {
    await router.emitLearningsDraftDecision(runId, routed);
  } catch (err) {
    // The draft card failing (e.g. inbox IO) must not take the system arm down
    // with it — the domain entries are still recoverable from this log line
    // and the run's learnings.md; the system analysis proceeds regardless.
    console.warn(
      `[learnings-router] draft card emission failed for ${runId.slice(0, 8)}: ${(err as Error).message}`,
    );
  }
  if (routed.systemContent) {
    await analyze(
      runId,
      composeImprovementAnalysisContent(rationale, routed.systemContent),
      placeholderId,
    );
    return;
  }
  engine.markImprovementTerminal(
    runId,
    placeholderId,
    'no-changes',
    `Routed ${routed.drafts.length} domain ${routed.drafts.length === 1 ? 'draft' : 'drafts'} and ${routed.holds.length} teaching ${routed.holds.length === 1 ? 'hold' : 'holds'} — nothing classified for the project-template improvement path.`,
  );
}

// Bounds crash-loop retries: an `analyzing` placeholder is re-run at most once
// by startup recovery (initial attempt + one resume) before terminalizing.
const MAX_ANALYSIS_ATTEMPTS = 2;

// Placeholder ids with an analysis in flight in this process — a second
// resume call (or any future re-entry) must neither double-run the analysis
// nor mistake the in-flight bump for a crash-loop and tombstone it at the cap.
const inFlightResumes = new Set<string>();

/**
 * Startup recovery for improvement analyses interrupted by a gateway restart.
 * The persisted `analyzing` placeholder decision IS the durable job state: its
 * run id + decision id are enough to re-run the analysis in place. Attempt
 * bumps are persisted BEFORE the re-run so a crash loop cannot retry forever;
 * placeholders at the cap terminalize as `error` instead.
 *
 * Ledger mutations (attempt bump / tombstone) happen synchronously so callers
 * can sequence them before the first decision broadcast; the LLM re-runs
 * themselves are fire-and-forget like every other analysis kickoff.
 */
export async function resumeInterruptedImprovementAnalyses(): Promise<void> {
  const engine = await import('../../intelligence/improvement-engine.js');
  let resumed = 0;
  let terminalized = 0;
  for (const run of getAllRuns()) {
    for (const decision of run.decisions ?? []) {
      if (decision.type !== 'improvement') continue;
      const payload = decision.payload as ImprovementDiffPayload | undefined;
      if (payload?.analysisStatus !== 'analyzing') continue;
      if (inFlightResumes.has(decision.id)) continue;

      const attempts = payload.analysisAttempts ?? 1;
      if (attempts >= MAX_ANALYSIS_ATTEMPTS) {
        engine.markImprovementTerminal(
          run.id,
          decision.id,
          'error',
          'Gateway restarted before analysis finished and the retry limit was reached. Re-trigger from the family page if you want to retry.',
        );
        terminalized += 1;
        continue;
      }

      payload.analysisAttempts = attempts + 1;
      payload.analysisStartedAt = new Date().toISOString();
      const updated = updateRun(run.id, { decisions: run.decisions });
      // updateRun persists in the background; the bump must be DURABLE before
      // the re-run starts, or a crash mid-analysis leaves the old count on
      // disk and the cap never engages across a crash loop.
      await persistRunNow(updated, 'improvement-resume');
      resumed += 1;

      inFlightResumes.add(decision.id);
      const analyzer = improvementAnalyzer ?? engine.analyzeAndPropose;
      void (async () => {
        const content = await composeFamilyLearnings(run);
        if (!content.trim()) {
          engine.markImprovementTerminal(
            run.id,
            decision.id,
            'no-content',
            'No learnings.md content was found for this run or its family root, so the improvement engine has nothing to analyze.',
          );
          return;
        }
        await routeThenAnalyze(run.id, run, content, decision.id, analyzer);
      })()
        .catch((err) => {
          // Terminalize instead of leaving the card `analyzing` forever — the
          // resume path has no request context to surface the failure through.
          engine.markImprovementTerminal(run.id, decision.id, 'error', (err as Error).message);
        })
        .finally(() => {
          inFlightResumes.delete(decision.id);
        });
    }
  }
  if (resumed > 0 || terminalized > 0) {
    console.log(
      `[improvement] startup resume: ${resumed} analysis re-run(s) kicked, ${terminalized} at retry cap terminalized`,
    );
  }
}

export async function triggerImprovementAnalysis(runId: string, run: Run): Promise<void> {
  // The improvement engine uses its module-scoped broadcastFn (set via
  // initImprovementEngine at gateway startup) so events reach every connected
  // client — including the inbox tab when accept arrives via decision.resolve,
  // whose run-decision path passes a no-op per-request emit. We intentionally
  // do not thread the per-request emit through here.
  // Hoist the dynamic import so the catch path doesn't re-resolve the module
  // when terminalizing the placeholder on error. (Top-level static import is
  // avoided because the engine has heavier deps and only loads on accept.)
  const engine = await import('../../intelligence/improvement-engine.js');
  let placeholderId: string | null = null;
  try {
    placeholderId = engine.emitImprovementPlaceholder(runId);
    // If the run was deleted between accept and analysis kickoff,
    // emitImprovementPlaceholder returns null. There's no card to update and
    // no run state to mutate — bail out rather than letting analyzeAndPropose
    // re-create a stranded ad-hoc placeholder for a missing run.
    if (!placeholderId) {
      console.warn(`[improvement] run ${runId} disappeared before analysis kickoff`);
      return;
    }
    const content = await composeFamilyLearnings(run);
    if (!content.trim()) {
      if (placeholderId) {
        engine.markImprovementTerminal(
          runId,
          placeholderId,
          'no-content',
          'No learnings.md content was found for this run or its family root, so the improvement engine has nothing to analyze.',
        );
      }
      return;
    }
    await routeThenAnalyze(runId, run, content, placeholderId, engine.analyzeAndPropose);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[improvement] analysis failed: ${message}`);
    if (placeholderId) {
      engine.markImprovementTerminal(runId, placeholderId, 'error', message);
    }
  }
}

/** Compose the analysis content sent into the improvement engine. Exported for tests. */
export function composeImprovementAnalysisContent(
  rationale: string | undefined,
  learnings: string,
): string {
  const trimmed = rationale?.trim();
  return (
    (trimmed ? `## Human rationale\n${trimmed}\n\n` : '') + `## Worker learnings\n${learnings}`
  );
}

type ImprovementAnalyzer = (
  runId: string,
  content: string,
  placeholderDecisionId?: string,
) => Promise<void>;

/** Tests override this to capture the analyzer call without hitting the real LLM. */
let improvementAnalyzer: ImprovementAnalyzer | null = null;

export function __setImprovementAnalyzerForTest(fn: ImprovementAnalyzer | null): void {
  improvementAnalyzer = fn;
}

export async function runProposeImprovement(
  params: RunProposeImprovementParams,
  emit: Emit,
): Promise<RunProposeImprovementResult> {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);
  if (!existing.taskFile) {
    throw new Error(`Cannot propose improvement: run ${params.runId.slice(0, 8)} has no taskFile`);
  }

  const learningsContent = await readRunLearnings(existing);
  if (!learningsContent.trim()) {
    throw new Error(
      `Cannot propose improvement: no learnings.md content for run ${params.runId.slice(0, 8)}`,
    );
  }

  // Fire-and-forget: the LLM roundtrip can take minutes. Emit a placeholder
  // immediately so the inbox shows progress + survives reload, then thread its
  // id through so the success/no-changes/error branches replace this same card
  // in place rather than spawning a fresh decision. The learnings are routed
  // (system vs domain) before the improvement engine sees them; the rationale
  // rejoins the system-only content inside routeThenAnalyze.
  const engine = await import('../../intelligence/improvement-engine.js');
  const placeholderId = engine.emitImprovementPlaceholder(params.runId);
  const analyzer: Promise<ImprovementAnalyzer> = improvementAnalyzer
    ? Promise.resolve(improvementAnalyzer)
    : Promise.resolve(engine.analyzeAndPropose satisfies ImprovementAnalyzer);
  void analyzer
    .then((fn) =>
      placeholderId
        ? routeThenAnalyze(
            params.runId,
            existing,
            learningsContent,
            placeholderId,
            fn,
            params.rationale,
          )
        : undefined,
    )
    .catch((err) => {
      const message = (err as Error).message || 'Unknown error';
      console.warn(
        `[improvement] proposeImprovement analysis failed for ${params.runId.slice(0, 8)}: ${message}`,
      );
      if (placeholderId) {
        engine.markImprovementTerminal(params.runId, placeholderId, 'error', message);
      }
      // Legacy public-API contract: callers of run.proposeImprovement (chat
      // refine flows etc.) subscribe to RUN_IMPROVEMENT_FAILED for terminal
      // status. The internal triggerImprovementAnalysis path doesn't emit
      // this — its callers rely on the placeholder card transitioning to
      // 'error' state via DECISION_UPDATED instead.
      emit(Events.RUN_IMPROVEMENT_FAILED, { runId: params.runId, error: message });
    });

  return { ok: true };
}
