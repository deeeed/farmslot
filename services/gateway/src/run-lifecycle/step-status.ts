import { PipelineSteps as S, type Run, type RunStatus } from '@farmslot/protocol';

/** Pipeline entry and restart recovery share the same status projection. */
export const STEP_TO_STATUS: Readonly<Record<string, RunStatus>> = {
  [S.GRADE]: 'grading',
  [S.WRITE_TASK]: 'writing-task',
  [S.FIND_SLOT]: 'slot-finding',
  [S.PREPARE]: 'preparing',
  [S.DISPATCH]: 'dispatching',
  [S.MONITOR]: 'monitoring',
  [S.REVIEW]: 'reviewing',
  [S.HUMAN_GATE]: 'human-gating',
  [S.FINALIZE]: 'completing',
  [S.COMPLETE]: 'completing',
  [S.CI_WATCH]: 'ci-watching',
};

/** A failed deterministic gate keeps its resources until an operator settles or replays it. */
export function isCompletionPrerequisiteFailure(
  run: Pick<Run, 'status'> & Partial<Pick<Run, 'steps'>>,
): boolean {
  return (
    run.status === 'failed' &&
    Boolean(
      run.steps?.some(
        (step) =>
          (step.name === S.COMPLETE || step.name === S.FINALIZE) &&
          step.status === 'failed' &&
          step.outputs?.gatePrerequisiteRefusal !== undefined,
      ),
    )
  );
}
