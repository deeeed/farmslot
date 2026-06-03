import type {
  FamilyObservabilityRunSummary,
  HumanGrade,
  ProofTargetVerdict,
} from '@farmslot/protocol';
import { DEFAULT_GRADER_ID } from '@farmslot/protocol';

import type { SemanticValue } from './grade-semantic-picker.js';

export interface GradeDraft {
  semantic: SemanticValue;
  reasoning: string;
  verdicts: Map<string, Partial<ProofTargetVerdict>>;
  overridden: boolean;
}

export type VerdictValue = ProofTargetVerdict['verdict'];
export type GradeVerdictDraft = Partial<ProofTargetVerdict>;

export function canGradeFamilyRun(
  run: Pick<FamilyObservabilityRunSummary, 'status' | 'steps'>,
): boolean {
  if (!['done', 'failed', 'cancelled'].includes(run.status)) return false;
  const monitorStep = run.steps.find((step) => step.stepName === 'monitor');
  return Boolean(
    monitorStep && monitorStep.status !== 'pending' && monitorStep.status !== 'skipped',
  );
}

export function deriveSemantic(verdicts: Map<string, Partial<ProofTargetVerdict>>): SemanticValue {
  if (verdicts.size === 0) return '';
  let allPass = true;
  for (const entry of verdicts.values()) {
    if (entry.verdict === 'fail') return 'bad';
    if (entry.verdict !== 'pass') allPass = false;
  }
  if (allPass) return 'good';
  return 'ok';
}

export function familyHasConvergedGood(
  runs: readonly Pick<FamilyObservabilityRunSummary, 'humanGrade'>[],
): boolean {
  const graded = runs.filter((run) => run.humanGrade);
  if (graded.length === 0) return false;
  return graded.every((run) => {
    if (run.humanGrade?.recipe_semantic !== 'good') return false;
    const verdicts = run.humanGrade.proof_target_verdicts ?? [];
    return verdicts.every((verdict) => verdict.verdict !== 'fail');
  });
}

export function createGradeDraft(
  run: Pick<FamilyObservabilityRunSummary, 'proofTargets' | 'humanGrade'>,
): GradeDraft {
  const verdicts = new Map<string, Partial<ProofTargetVerdict>>();
  for (const target of run.proofTargets ?? []) {
    verdicts.set(target.id, { id: target.id, target: target.target });
  }
  const grade = run.humanGrade;
  if (grade) {
    for (const v of grade.proof_target_verdicts ?? []) {
      verdicts.set(v.id, { id: v.id, target: v.target, verdict: v.verdict, note: v.note });
    }
    // Only treat as overridden when the saved semantic disagrees with what the
    // verdicts would derive — otherwise later verdict edits must keep recomputing.
    const overridden = grade.recipe_semantic !== deriveSemantic(verdicts);
    return {
      semantic: grade.recipe_semantic,
      reasoning: grade.reasoning ?? '',
      verdicts,
      overridden,
    };
  }
  return { semantic: '', reasoning: '', verdicts, overridden: false };
}

export function updateGradeDraftVerdict(
  draft: GradeDraft,
  targetId: string,
  verdict: VerdictValue,
): GradeDraft {
  const nextVerdicts = new Map(draft.verdicts);
  const prev = nextVerdicts.get(targetId) ?? { id: targetId };
  nextVerdicts.set(targetId, { ...prev, verdict });
  return {
    ...draft,
    verdicts: nextVerdicts,
    semantic: draft.overridden ? draft.semantic : deriveSemantic(nextVerdicts),
  };
}

export function updateGradeDraftNote(
  draft: GradeDraft,
  targetId: string,
  note: string,
): GradeDraft {
  const nextVerdicts = new Map(draft.verdicts);
  const prev = nextVerdicts.get(targetId) ?? { id: targetId };
  nextVerdicts.set(targetId, { ...prev, note });
  return { ...draft, verdicts: nextVerdicts };
}

export function hasFailingGradeVerdict(draft: GradeDraft): boolean {
  return [...draft.verdicts.values()].some((v) => v.verdict === 'fail');
}

export function humanGradeFromDraft(
  draft: GradeDraft & { semantic: Exclude<SemanticValue, ''> },
  gradedAt = new Date().toISOString(),
): HumanGrade {
  const proofTargetVerdicts: ProofTargetVerdict[] = [];
  for (const [id, entry] of draft.verdicts.entries()) {
    if (!entry || entry.verdict === undefined) continue;
    const target = entry.target;
    if (!target) continue;
    proofTargetVerdicts.push({
      id,
      target,
      verdict: entry.verdict,
      note: entry.note?.trim() || undefined,
    });
  }
  return {
    recipe_semantic: draft.semantic,
    reasoning: draft.reasoning,
    graded_by: DEFAULT_GRADER_ID,
    graded_at: gradedAt,
    ...(proofTargetVerdicts.length > 0 ? { proof_target_verdicts: proofTargetVerdicts } : {}),
  };
}
