import type { DepsCheck } from './deps-readiness.js';

/** Stable id a host branches on when executing `actions[]`. */
export interface RuntimeDecisionAction {
  id: string;
  argv?: string[];
  cwd?: string;
  paths?: string[];
}

export type RuntimeReadinessDecision =
  | 'install'
  | 'build'
  | 'launch'
  | 'relaunch'
  | 'ready'
  | 'blocked'
  | 'unknown';

export interface RuntimeDecisionReport<
  TChecks extends Record<string, unknown> = Record<string, unknown>,
> {
  schemaVersion: 1;
  adapter: string;
  target: string;
  decision: RuntimeReadinessDecision;
  reasonCode: string;
  reasons: string[];
  checks: TChecks;
  actions: RuntimeDecisionAction[];
  /** Extension-only: build must clear webpack cache first. */
  clean?: boolean;
}

export type { DepsCheck };
