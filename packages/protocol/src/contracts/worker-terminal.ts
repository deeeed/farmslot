export type WorkerTerminalCommand = 'complete' | 'no-change' | 'blocked';

export interface WorkerTerminalCommandSpec {
  report?: string;
  artifacts: string[];
}

export interface WorkerTerminalWhenPresentRule {
  path: string;
  alsoRequire: string[];
  requireRecipeQuality?: boolean;
  requireRecipeCoverage?: boolean;
}

/**
 * Acceptance-ledger rules for a terminal mark (ADR-060).
 *
 * `require` is the opt-in: only a project that declares it makes a missing or
 * incomplete ledger block `complete`. It defaults to false because a template
 * that has not adopted `farmslot-agent ac` writes no ledger, and enforcing it
 * there would fail every run whose ticket happens to carry criteria. The ledger
 * is still watched, projected and preferred for coverage without it.
 *
 * `allowWeak` lets a flow finish with `weak` or `missing` verdicts; every
 * criterion still needs one.
 */
export interface WorkerTerminalAcceptanceRules {
  require?: boolean;
  allowWeak?: boolean;
}

export interface WorkerTerminalProjectConfig {
  requireSignal?: boolean;
  acceptance?: WorkerTerminalAcceptanceRules;
  complete?: WorkerTerminalCommandSpec;
  'no-change'?: WorkerTerminalCommandSpec;
  blocked?: WorkerTerminalCommandSpec;
  flows?: Record<string, Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>>>;
  whenPresent?: WorkerTerminalWhenPresentRule[];
}

export interface WorkerTerminalContractDocument {
  schemaVersion: 1;
  flowType: string;
  mode?: string;
  requireSignal: boolean;
  /** Present only when the project declares acceptance rules. */
  acceptance?: WorkerTerminalAcceptanceRules;
  commands: Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>;
  whenPresent: WorkerTerminalWhenPresentRule[];
  resolvedAt: string;
  source: 'builtin' | 'project';
}

export const WORKER_TERMINAL_CONTRACT_INPUT = 'inputs/worker-terminal-contract.json';
