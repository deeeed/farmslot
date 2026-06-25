// task-steps.ts — GRADE and WRITE_TASK run-engine step owners.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactRef,
  Events,
  isLightweightInteractiveDevRun,
  parseGitHubRef,
  PipelineSteps,
  RECIPE_STRATEGY_LABELS,
  type ReviewGatePayload,
  type Run,
  type TemplateProvenance,
} from '@farmslot/protocol';

import { farmslotRoot, getOrchestratorTaskRoot, getProjectField } from '../core/config.js';
import { updateSlotStatus } from '../core/state.js';
import { fetchPRDiffFiles } from '../external/github.js';
import {
  buildSmartBranch,
  computeOverrideRate,
  generateSummary,
  gradeTicket,
  selectRecipeStrategy,
} from '../intelligence/engine.js';
import { getRun, listRuns, updateRun, updateRunStep } from '../runs/store.js';
import {
  CHECKLIST_MARKER_INPUT,
  TaskCollisionError,
  TEMPLATE_PROVENANCE_INPUT,
  writeTaskFile,
} from '../tasks/writer.js';

import { requiresCollisionPrecheck } from './decision-replay.js';
import { captureReviewInputArtifactsForRun } from './diff-artifacts.js';
import { createEngineDecision, handleCollisionDecision } from './engine-decisions.js';
import { normalizeEvalReplayForTaskWrite } from './eval-replay-normalization.js';
import { detectProjectMismatch } from './project-fit-gate.js';
import { loadProjectVarsOrNull } from './project-vars.js';
import { refreshRunLinks } from './run-links.js';
import { createSubStepCollector } from './sub-step-collector.js';
import { detectFlowTypeMismatch, fetchPRData, fetchTicketData } from './ticket-data.js';

interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

type BroadcastFn = (event: string, payload: unknown) => void;
type StepPartialIOMap = Map<string, StepIO>;

const S = PipelineSteps;

const FLOW_TO_TASK_TEMPLATE: Partial<Record<Run['flowType'], string>> = {
  'fix-bug': 'fix-bug.md',
  'review-pr': 'review-pr.md',
  dev: 'dev.md',
  'pr-complete': 'pr-complete.md',
};

async function readTemplateProvenanceForTask(
  taskFilePath: string,
): Promise<TemplateProvenance | null> {
  const provenancePath = path.join(path.dirname(taskFilePath), TEMPLATE_PROVENANCE_INPUT);
  if (!existsSync(provenancePath)) return null;
  const parsed = JSON.parse(await readFile(provenancePath, 'utf-8')) as TemplateProvenance;
  if (parsed?.kind !== 'task-template' || typeof parsed.contentHash !== 'string') {
    throw new Error(`Invalid template provenance artifact: ${provenancePath}`);
  }
  return parsed;
}

async function resolveRecipeStrategy(
  runId: string,
  current: Run,
): Promise<Awaited<ReturnType<typeof selectRecipeStrategy>> | null> {
  try {
    // Re-read run state in case GRADE step mutated ticketData
    const freshRun = getRun(runId) ?? current;
    const prRef = parseGitHubRef(freshRun.ticketOrPr);
    if (!prRef) return null;

    const diffFiles = await fetchPRDiffFiles(prRef.repo, prRef.number);
    const result = await selectRecipeStrategy(diffFiles, 'standard', freshRun.ticketData);

    // Read project config for suggest vs autonomous mode
    const projVars = await loadProjectVarsOrNull(current.project, 'run step', current.id);
    const prefilterConfig = projVars?.projectJson?.evidence_prefilter;
    let mode: 'suggest' | 'autonomous' = 'suggest';
    if (prefilterConfig?.mode === 'autonomous') {
      // Validate override rate before granting autonomous mode
      const minRuns = prefilterConfig.min_runs_for_autonomous ?? 20;
      const completedRuns = listRuns().runs.filter(
        (r) => r.flowType === 'review-pr' && r.project === current.project && r.completedAt,
      );
      // Extract quality reports from decision payloads (not a top-level Run field)
      const runsWithReports = completedRuns.map((r) => {
        const reviewDecision = r.decisions.find(
          (d) => d.type === 'engine_review_posting' && d.resolvedAt,
        );
        const payload = reviewDecision?.payload as ReviewGatePayload | undefined;
        return { evidenceQualityReport: payload?.qualityReport ?? null };
      });
      const { rate, totalRuns } = computeOverrideRate(runsWithReports);
      mode = totalRuns >= minRuns && rate < 0.15 ? 'autonomous' : 'suggest';
      if (mode === 'suggest') {
        console.log(
          `[run-engine] autonomous mode not yet earned: ${totalRuns}/${minRuns} runs, ${(rate * 100).toFixed(0)}% override rate`,
        );
      }
    }
    result.strategy.mode = mode;

    console.log(
      `[run-engine] recipe strategy for ${runId.slice(0, 8)}: ${result.strategy.strategy} (${result.strategy.mode})`,
    );

    // In suggest mode: pause for human confirmation
    if (result.strategy.mode === 'suggest') {
      const recommended = RECIPE_STRATEGY_LABELS[result.strategy.strategy];
      const desc = [
        `**Recommended:** ${recommended.label} (\`${result.strategy.strategy}\`) — ${recommended.tagline}`,
        `**Why:** ${result.strategy.reasoning}`,
        `**UI impact:** ${result.strategy.uiImpact ? 'yes' : 'no'}`,
      ].join('\n');
      const actionId = await createEngineDecision(runId, 'recipe_strategy', desc, [
        { id: 'accept', label: `Use recommended (${recommended.label})`, style: 'primary' },
        {
          id: 'full-qa',
          label: `${RECIPE_STRATEGY_LABELS['full-qa'].label} — ${RECIPE_STRATEGY_LABELS['full-qa'].tagline}`,
          style: 'secondary',
        },
        {
          id: 'targeted',
          label: `${RECIPE_STRATEGY_LABELS['targeted'].label} — ${RECIPE_STRATEGY_LABELS['targeted'].tagline}`,
          style: 'secondary',
        },
        {
          id: 'smoke',
          label: `${RECIPE_STRATEGY_LABELS['smoke'].label} — ${RECIPE_STRATEGY_LABELS['smoke'].tagline}`,
          style: 'secondary',
        },
      ]);
      if (actionId === 'full-qa') result.strategy.strategy = 'full-qa';
      else if (actionId === 'targeted') result.strategy.strategy = 'targeted';
      else if (actionId === 'smoke') result.strategy.strategy = 'smoke';
    }

    return result;
  } catch (err) {
    console.warn(
      `[run-engine] recipe strategy selection failed (non-fatal): ${(err as Error).message}`,
    );
    return null;
  }
}

export async function executeGradeStep(
  runId: string,
  run: Run,
  stepPartialIO: StepPartialIOMap,
): Promise<StepIO> {
  const inputs: Record<string, unknown> = { ticketOrPr: run.ticketOrPr };
  // Fetch ticket data from Jira/GitHub unless the run was created with
  // explicit context, such as eval replay candidates.
  const ticketData = run.ticketData ?? (await fetchTicketData(run));
  if (ticketData && !run.ticketData) {
    updateRun(runId, { ticketData });
    await refreshRunLinks(runId);
  }
  if (ticketData) {
    inputs.ticketSource = ticketData.source;
  }
  // Guard: fix-bug and feature flows require ticket context
  if (!ticketData && ['fix-bug', 'dev'].includes(run.flowType)) {
    stepPartialIO.set(runId, { inputs, outputs: { error: 'No ticket data found' } });
    throw new Error(
      `No ticket data found for "${run.ticketOrPr}". Check Jira credentials and ticket key format.`,
    );
  }
  let projectMismatchOverride: Record<string, unknown> | null = null;
  const projectMismatch = await detectProjectMismatch(run, ticketData);
  if (projectMismatch) {
    const actionId = await createEngineDecision(
      runId,
      'project_mismatch',
      `Ticket "${projectMismatch.normalizedTicket ?? run.ticketOrPr}" appears to belong to project "${projectMismatch.suggestedProject}", but this run is on "${run.project}". ${projectMismatch.rationale} Continue anyway?`,
      [
        { id: 'continue', label: `Continue on ${run.project}`, style: 'primary' },
        { id: 'abort', label: 'Abort run', style: 'danger' },
      ],
    );
    if (actionId === 'abort') {
      stepPartialIO.set(runId, {
        inputs,
        outputs: {
          projectMismatch,
          source: ticketData?.source,
          title: ticketData?.title,
        },
      });
      throw new Error(`Project mismatch: aborted by user`);
    }
    projectMismatchOverride = { projectMismatch, overriddenBy: 'user' };
  }
  // Validate flow type matches ticket type
  let flowTypeMismatch: string | null = null;
  if (ticketData?.issueType) {
    flowTypeMismatch = detectFlowTypeMismatch(run.flowType, ticketData.issueType);
    if (flowTypeMismatch) {
      // Ask human: continue anyway or abort?
      const actionId = await createEngineDecision(
        runId,
        'flow_type_mismatch',
        `Jira issue "${ticketData.issueType}" doesn't match flow "${run.flowType}". ${flowTypeMismatch}. Continue anyway?`,
        [
          { id: 'continue', label: `Continue as ${run.flowType}`, style: 'primary' },
          { id: 'abort', label: 'Abort run', style: 'danger' },
        ],
      );
      if (actionId === 'abort') {
        stepPartialIO.set(runId, {
          inputs,
          outputs: { flowTypeMismatch, source: ticketData.source, title: ticketData.title },
        });
        throw new Error(`Flow type mismatch: aborted by user`);
      }
      // User chose to continue — proceed with the flow as-is
    }
  }
  // Grade the ticket
  const outputs: Record<string, unknown> = { flowTypeMismatch };
  if (projectMismatchOverride) outputs.projectMismatchOverride = projectMismatchOverride;
  if (ticketData && run.engineState?.evalExperiment) {
    const grade = {
      difficulty: 'medium' as const,
      rationale: 'Eval replay candidate: grading is fixed to avoid non-deterministic LLM delay.',
      modelRecommendation: run.metrics.model ?? 'sonnet',
      score: 5,
    };
    updateRun(runId, { grade });
    outputs.difficulty = grade.difficulty;
    outputs.modelRecommendation = grade.modelRecommendation;
    outputs.score = grade.score;
    outputs.rationale = grade.rationale;
  } else if (ticketData) {
    try {
      const { grade, usage } = await gradeTicket(ticketData, getRun(runId)!.project);
      updateRun(runId, { grade });
      // Apply model recommendation only if user didn't specify any model
      const current = getRun(runId)!;
      if (!current.metrics.model) {
        updateRun(runId, { metrics: { ...current.metrics, model: grade.modelRecommendation } });
      }
      console.log(
        `[run-engine] graded ${runId.slice(0, 8)}: ${grade.difficulty} → ${grade.modelRecommendation}`,
      );
      outputs.difficulty = grade.difficulty;
      outputs.modelRecommendation = grade.modelRecommendation;
      outputs.score = grade.score;
      outputs.rationale = grade.rationale;
      outputs.llm = usage;
    } catch (err) {
      console.warn(`[run-engine] grading failed (non-fatal): ${(err as Error).message}`);
    }
  }
  if (ticketData) {
    outputs.source = ticketData.source;
    outputs.title = ticketData.title;
    if (run.engineState?.evalExperiment) {
      updateRun(runId, { summary: ticketData.title });
      outputs.summary = ticketData.title;
      outputs.summarySource = 'eval-title';
    } else {
      // Generate LLM summary + branch slug (non-fatal)
      try {
        const summaryResult = await generateSummary(ticketData, run.flowType);
        const branchUpdate: Partial<Run> = { summary: summaryResult.summary };
        if (!getRun(runId)!.branch) {
          const pv = await loadProjectVarsOrNull(run.project, 'run recovery', run.id);
          const ns = pv?.projectJson
            ? (getProjectField(pv.projectJson, 'branch_namespace') ?? undefined)
            : undefined;
          const bf = pv?.projectJson
            ? (getProjectField(pv.projectJson, 'branch_format') ?? undefined)
            : undefined;
          branchUpdate.branch = buildSmartBranch(
            run.flowType,
            run.ticketOrPr,
            summaryResult.branchSlug,
            ns,
            run.variant,
            bf,
          );
        }
        updateRun(runId, branchUpdate);
        outputs.summary = summaryResult.summary;
        outputs.branchSlug = summaryResult.branchSlug;
        outputs.summaryLlm = summaryResult.usage;
        console.log(`[run-engine] summary for ${runId.slice(0, 8)}: "${summaryResult.summary}"`);
      } catch (err) {
        console.warn(
          `[run-engine] summary generation failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }
  }
  return { inputs, outputs };
}

export async function executeWriteTaskStep(
  runId: string,
  currentRun: Run,
  deps: {
    broadcastFn: BroadcastFn;
    stepPartialIO: StepPartialIOMap;
  },
): Promise<StepIO> {
  const { broadcastFn, stepPartialIO } = deps;
  const run = currentRun;
  const current = await normalizeEvalReplayForTaskWrite(runId, getRun(runId)!);
  const inputs: Record<string, unknown> = {
    flowType: current.flowType,
    hasTicketData: !!current.ticketData,
  };
  // Skip if taskFile already provided
  if (current.taskFile) {
    console.log(`[run-engine] taskFile already set, skipping write-task`);
    const templateName = FLOW_TO_TASK_TEMPLATE[current.flowType] ?? `${current.flowType}.md`;
    const pv = await loadProjectVarsOrNull(current.project, 'run step', current.id);
    const orchestratorTaskRoot = pv
      ? getOrchestratorTaskRoot(current.project, pv.projectJson)
      : path.join(farmslotRoot, 'projects', current.project, 'tasks');
    const relPath = path.relative(orchestratorTaskRoot, current.taskFile);
    const taskRelDir =
      !relPath || relPath.startsWith('..') ? undefined : relPath.replace(/\/TASK\.md$/, '');
    if (current.slotId && taskRelDir) {
      await updateSlotStatus(current.slotId, {
        task_file: taskRelDir,
        task_id: current.ticketOrPr,
      });
    }
    const templateProvenance = await readTemplateProvenanceForTask(current.taskFile);
    if (templateProvenance) updateRun(runId, { templateProvenance });
    const artifacts: ArtifactRef[] = [
      { path: 'TASK.md', purpose: 'task-md' },
      { path: CHECKLIST_MARKER_INPUT, purpose: 'checklist-marker' },
      { path: TEMPLATE_PROVENANCE_INPUT, purpose: 'template-provenance' },
    ];
    const inputArtifacts = await captureReviewInputArtifactsForRun(current);
    artifacts.push(...inputArtifacts);
    return {
      inputs,
      outputs: {
        taskFile: current.taskFile,
        templateName,
        taskRelDir,
        artifacts,
        skipped: true,
      },
    };
  }

  // Sub-step telemetry — write-task does several network/LLM calls (PR fetch,
  // PR comments, recipe extraction). Without telemetry the UI shows a single
  // "writing-task" row stuck for ~90s on pr-complete; sub-steps surface what
  // is actually happening.
  const collector = createSubStepCollector();
  const emitWithBroadcast = (event: string, payload: unknown) => {
    collector.emit(event, payload);
    const p = payload as { name?: string; detail?: string } | undefined;
    if (p?.name) {
      const outputs: Record<string, unknown> = { subSteps: collector.snapshot() };
      updateRunStep(runId, S.WRITE_TASK, { detail: p.detail || p.name, outputs });
      stepPartialIO.set(runId, { inputs, outputs });
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    }
  };

  // For PR flows: fetch PR metadata + set branch
  if (
    (current.flowType === 'review-pr' || current.flowType === 'pr-complete') &&
    !current.ticketData
  ) {
    emitWithBroadcast('substep', {
      name: 'fetch-pr-data',
      detail: `Fetching PR ${current.ticketOrPr}`,
    });
    await fetchPRData(runId);
  }
  // For feature flows without GRADE step: fetch ticket data so TASK.md gets real title/description
  if (current.flowType === 'dev' && !current.ticketData) {
    emitWithBroadcast('substep', {
      name: 'fetch-ticket',
      detail: `Fetching ticket ${current.ticketOrPr}`,
    });
    const ticketData = await fetchTicketData(current);
    if (ticketData) {
      updateRun(runId, { ticketData });
      await refreshRunLinks(runId);
    }
  }

  // Phase 1 pre-filter: recipe strategy selection for review-pr flows
  // Skip when tier is manually selected — human already made an informed choice
  let recipeStrategyResult = null as Awaited<ReturnType<typeof resolveRecipeStrategy>> | null;
  if (current.flowType === 'review-pr' && !current.reviewTier) {
    emitWithBroadcast('substep', {
      name: 'recipe-strategy',
      detail: 'Selecting review recipe strategy',
    });
    recipeStrategyResult = await resolveRecipeStrategy(runId, current);
  }

  // Generate summary if not already set (GRADE step sets it for fix-bug flows)
  const afterFetch = getRun(runId)!;
  if (!afterFetch.summary && afterFetch.ticketData) {
    try {
      if (afterFetch.flowType === 'review-pr' || afterFetch.flowType === 'pr-complete') {
        // PR flows: use PR title directly — no LLM needed
        updateRun(runId, { summary: afterFetch.ticketData.title });
        console.log(
          `[run-engine] summary for ${runId.slice(0, 8)} (PR title): "${afterFetch.ticketData.title}"`,
        );
      } else if (afterFetch.flowType === 'dev') {
        // Feature flows: LLM summary + smart branch (matches fix-bug behavior)
        emitWithBroadcast('substep', {
          name: 'summarize-ticket',
          detail: 'Generating summary and branch',
        });
        const summaryResult = await generateSummary(afterFetch.ticketData, afterFetch.flowType);
        const branchUpdate: Partial<Run> = { summary: summaryResult.summary };
        if (!afterFetch.branch) {
          const pv = await loadProjectVarsOrNull(run.project, 'run recovery', run.id);
          const ns = pv?.projectJson
            ? (getProjectField(pv.projectJson, 'branch_namespace') ?? undefined)
            : undefined;
          const bf = pv?.projectJson
            ? (getProjectField(pv.projectJson, 'branch_format') ?? undefined)
            : undefined;
          branchUpdate.branch = buildSmartBranch(
            afterFetch.flowType,
            afterFetch.ticketOrPr,
            summaryResult.branchSlug,
            ns,
            afterFetch.variant,
            bf,
          );
        }
        updateRun(runId, branchUpdate);
        console.log(`[run-engine] summary for ${runId.slice(0, 8)}: "${summaryResult.summary}"`);
      }
    } catch (err) {
      console.warn(`[run-engine] write-task summary failed (non-fatal): ${(err as Error).message}`);
    }
  }

  // Template name mapping
  const FLOW_TO_TEMPLATE: Record<string, string> = {
    'fix-bug': 'fix-bug.md',
    'review-pr': 'review-pr.md',
    dev: 'dev.md',
    'pr-complete': 'pr-complete.md',
  };
  const templateName = FLOW_TO_TEMPLATE[current.flowType] ?? `${current.flowType}.md`;

  // Extract relative task dir from absolute path using the orchestrator task root
  const pv = await loadProjectVarsOrNull(current.project, 'run step', current.id);
  const orchestratorTaskRoot = pv
    ? getOrchestratorTaskRoot(current.project, pv.projectJson)
    : path.join(farmslotRoot, 'projects', current.project, 'tasks');
  const extractTaskRelDir = (absPath: string): string | undefined => {
    const relPath = path.relative(orchestratorTaskRoot, absPath);
    if (!relPath || relPath.startsWith('..')) return undefined;
    return relPath.replace(/\/TASK\.md$/, '');
  };

  const buildWriteOutput = (
    taskFilePath: string,
    collision?: boolean,
    extraArtifacts: ArtifactRef[] = [],
  ): StepIO => {
    const taskRelDir = extractTaskRelDir(taskFilePath);
    const afterWrite = getRun(runId)!;
    const artifacts: ArtifactRef[] = [
      { path: 'TASK.md', purpose: 'task-md' },
      { path: CHECKLIST_MARKER_INPUT, purpose: 'checklist-marker' },
      { path: TEMPLATE_PROVENANCE_INPUT, purpose: 'template-provenance' },
    ];
    if (afterWrite.ticketData)
      artifacts.push({ path: 'inputs/bug-input.json', purpose: 'ticket-data' });
    if (isLightweightInteractiveDevRun(afterWrite)) {
      artifacts.push(
        { path: 'inputs/dev-intake.json', purpose: 'dev-intake' },
        { path: 'CHECKLIST.md', purpose: 'interactive-checklist' },
      );
    }
    artifacts.push(...extraArtifacts);
    return {
      inputs,
      outputs: {
        taskFile: taskFilePath,
        templateName,
        taskRelDir,
        branch: afterWrite.branch || undefined,
        summary: afterWrite.summary || undefined,
        artifacts,
        collision: collision || undefined,
        recipeStrategy: recipeStrategyResult?.strategy ?? undefined,
        subSteps: collector.finish(),
      },
    };
  };

  const skipCollision = !requiresCollisionPrecheck(current.flowType);
  const extraVars = recipeStrategyResult
    ? { RECIPE_STRATEGY: recipeStrategyResult.strategy.strategy }
    : undefined;
  let taskFilePath: string;
  let collision = false;
  try {
    taskFilePath = await writeTaskFile(current, {
      skipCollisionCheck: skipCollision,
      extraVars,
      onProgress: emitWithBroadcast,
    });
    updateRun(runId, { taskFile: taskFilePath });
  } catch (err) {
    if (err instanceof TaskCollisionError) {
      // Returns 'create-new' if the operator chose to fork; other actions
      // throw (abort / redirect) before this point.
      await handleCollisionDecision(runId, current, err.existingDirs, err.ticketSlug);
      // Retry write with collision check skipped.
      taskFilePath = await writeTaskFile(current, {
        skipCollisionCheck: true,
        extraVars,
        onProgress: emitWithBroadcast,
      });
      updateRun(runId, { taskFile: taskFilePath });
      collision = true;
    } else {
      throw err;
    }
  }
  // Propagate task_file to slot status for workspace detection once the
  // final task directory is known, then capture review inputs exactly once.
  if (current.slotId) {
    const relDir = extractTaskRelDir(taskFilePath);
    if (relDir) {
      await updateSlotStatus(current.slotId, {
        task_file: relDir,
        task_id: current.ticketOrPr,
      });
    } else {
      console.warn(
        `[run-engine] could not derive task rel dir from ${taskFilePath}; slot workspace pointer not updated`,
      );
    }
  }
  const templateProvenance = await readTemplateProvenanceForTask(taskFilePath);
  updateRun(runId, { templateProvenance });
  // Capture review-input artifacts after collision handling so they are
  // written under the final task path, not an abandoned TASK.md location.
  const inputArtifacts = await captureReviewInputArtifactsForRun(getRun(runId)!);
  return buildWriteOutput(taskFilePath, collision, inputArtifacts);
}
