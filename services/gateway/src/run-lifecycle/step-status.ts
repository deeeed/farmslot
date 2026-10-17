import { PipelineSteps as S, type RunStatus } from '@farmslot/protocol';

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
