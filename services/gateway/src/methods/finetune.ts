// methods/finetune.ts — Fine-tuning data export (C3)

import {
  type FinetuneExportDPOParams,
  type FinetuneExportDPOResult,
  type FinetuneExportSFTParams,
  type FinetuneExportSFTResult,
  type FinetuneIndexParams,
  type FinetuneIndexResult,
  isTerminalRunStatus,
  type Run,
} from '@farmslot/protocol';

import { runDurationMs } from '../runs/run-duration.js';
import { listRuns } from '../runs/store.js';

const GRADE_ORDER: Record<string, number> = { good: 3, ok: 2, bad: 1 };

function isTerminal(run: Run): boolean {
  return isTerminalRunStatus(run.status);
}

function collectStepOutputs(run: Run): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const step of run.steps) {
    if (step.outputs && Object.keys(step.outputs).length > 0) {
      outputs[step.name] = step.outputs;
    }
  }
  return outputs;
}

function filterByProject(runs: Run[], project?: string): Run[] {
  if (!project) return runs;
  return runs.filter((r) => r.project === project);
}

export function finetuneIndex(params: FinetuneIndexParams): FinetuneIndexResult {
  const { runs: allRuns } = listRuns({ limit: 1000 });
  const terminal = filterByProject(allRuns.filter(isTerminal), params.project);

  const stats = { total: terminal.length, graded: 0, good: 0, ok: 0, bad: 0 };
  const runs = terminal.map((r) => {
    const grade = r.humanGrade?.recipe_semantic;
    const hasGrade = !!grade;
    if (hasGrade) {
      stats.graded++;
      if (grade === 'good') stats.good++;
      else if (grade === 'ok') stats.ok++;
      else if (grade === 'bad') stats.bad++;
    }
    return {
      id: r.id,
      flowType: r.flowType,
      project: r.project,
      ticketOrPr: r.ticketOrPr,
      outcome: r.metrics.outcome ?? r.status,
      humanGrade: grade,
      model: r.metrics.model ?? 'unknown',
      durationMs: runDurationMs(r) ?? 0,
      stepCount: r.steps.filter((s) => s.status === 'done').length,
      hasGrade,
    };
  });

  return { runs, stats };
}

export function finetuneExportSFT(params: FinetuneExportSFTParams): FinetuneExportSFTResult {
  const { runs: allRuns } = listRuns({ limit: 1000 });
  let graded = filterByProject(allRuns.filter(isTerminal), params.project).filter(
    (r) => r.humanGrade,
  );

  if (params.minGrade) {
    const minOrder = GRADE_ORDER[params.minGrade] ?? 0;
    graded = graded.filter((r) => {
      const g = r.humanGrade?.recipe_semantic;
      return g && (GRADE_ORDER[g] ?? 0) >= minOrder;
    });
  }

  const examples = graded.map((r) => ({
    runId: r.id,
    flowType: r.flowType,
    ticketOrPr: r.ticketOrPr,
    input: {
      ticketData: r.ticketData ?? null,
      grade: r.grade ?? null,
      flowType: r.flowType,
      project: r.project,
      model: r.metrics.model,
    },
    output: {
      stepOutputs: collectStepOutputs(r),
      metrics: {
        durationMs: runDurationMs(r) ?? 0,
        nudgeCount: r.metrics.nudgeCount,
        outcome: r.metrics.outcome ?? r.status,
      },
    },
    label: r.humanGrade!.recipe_semantic,
  }));

  return { examples };
}

export function finetuneExportDPO(params: FinetuneExportDPOParams): FinetuneExportDPOResult {
  const { runs: allRuns } = listRuns({ limit: 1000 });
  const graded = filterByProject(allRuns.filter(isTerminal), params.project).filter(
    (r) => r.humanGrade,
  );

  // Group by ticketOrPr
  const byTicket = new Map<string, Run[]>();
  for (const r of graded) {
    const key = r.ticketOrPr;
    if (!byTicket.has(key)) byTicket.set(key, []);
    byTicket.get(key)!.push(r);
  }

  const pairs: FinetuneExportDPOResult['pairs'] = [];
  for (const [ticket, runs] of byTicket) {
    if (runs.length < 2) continue;

    // Sort by grade (best first)
    runs.sort((a, b) => {
      const ga = GRADE_ORDER[a.humanGrade?.recipe_semantic ?? ''] ?? 0;
      const gb = GRADE_ORDER[b.humanGrade?.recipe_semantic ?? ''] ?? 0;
      return gb - ga;
    });

    const best = runs[0];
    const worst = runs[runs.length - 1];
    const bestGrade = best.humanGrade?.recipe_semantic ?? '';
    const worstGrade = worst.humanGrade?.recipe_semantic ?? '';

    // Only pair if grades actually differ
    if (bestGrade === worstGrade) continue;

    pairs.push({
      ticketOrPr: ticket,
      chosen: {
        runId: best.id,
        model: best.metrics.model ?? 'unknown',
        grade: bestGrade,
        outputs: collectStepOutputs(best),
      },
      rejected: {
        runId: worst.id,
        model: worst.metrics.model ?? 'unknown',
        grade: worstGrade,
        outputs: collectStepOutputs(worst),
      },
    });
  }

  return { pairs };
}
