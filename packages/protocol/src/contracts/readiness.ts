/**
 * Readiness record: what a harness did to make a checkout ready for a task and
 * whether it succeeded. Farmslot defines the shape; a harness (mm-harness) fills
 * the steps. Lives at `<artifacts dir>/sandbox.json` — the task's `artifacts/`
 * for a skill run, the checkout runtime dir for a farm slot.
 */

export const READINESS_RECORD = 'sandbox.json';

export type ReadinessStepStatus = 'pass' | 'fail' | 'skipped';

export interface ReadinessStep {
  /** Stable step id, e.g. `doctor`, `status`, `launch`, `fixtures`, `verify`. */
  id: string;
  /** The exact command line the harness ran. */
  command: string;
  status: ReadinessStepStatus;
  exitCode: number;
  /** Report the step produced, relative to the record's directory, when it wrote one. */
  reportPath?: string;
  /** One-line reason for a fail or skip. */
  reason?: string;
}

export interface ReadinessRecord {
  schemaVersion: 1;
  harness: {
    name: string;
    version: string;
    /** How the executable was chosen: env override, task-local lock, PATH, … */
    source: string;
    executable: string;
  };
  platform: string;
  mobilePlatform?: 'ios' | 'android';
  steps: ReadinessStep[];
  /** True when every non-skipped step passed. */
  ready: boolean;
  recordedAt: string;
}
