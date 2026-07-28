/**
 * Operator provider subscription accounts for fleet UI.
 * Bind labels are farmslot-owned; identity/usage is mirrored from CodexBar (fail-open).
 * Tokens and credential paths are never included.
 */

export type ProviderRunnerAccountStatusKind =
  | 'bound'
  | 'ambient'
  | 'unsupported'
  | 'unknown'
  | 'error';

export interface ProviderRunnerCoolingEntry {
  label: string;
  tier?: string;
  expiresAt?: string;
}

/** Live identity/quota mirrored from CodexBar on the execution host. */
export interface ProviderRunnerUsageMirror {
  /** Account email from CodexBar when available (not persisted on RunMetrics). */
  accountEmail: string | null;
  /** 0–100 remaining on the primary usage window when known. */
  remainingPercent: number | null;
  /** 0–100 used when remaining is not directly reported. */
  usedPercent: number | null;
  resetsAt: string | null;
  loginMethod: string | null;
  /** CodexBar source tag (oauth, web, cli, …). */
  source: string | null;
  /** Fail-open probe error; row still returns without blocking UI. */
  error?: string;
}

/** One runner's connected subscription on a machine. */
export interface ProviderRunnerAccountStatus {
  runner: string;
  status: ProviderRunnerAccountStatusKind;
  /** Operator-local account label, or null when ambient/unsupported. */
  activeLabel: string | null;
  /** How the label was chosen: active-profile | slot-binding | ambient | … */
  source?: string | null;
  /** Labels currently cooling on this host (session/extended). */
  cooling?: ProviderRunnerCoolingEntry[];
  /** CodexBar mirror — email + quota for the node-active seat. */
  usage?: ProviderRunnerUsageMirror | null;
  error?: string;
}

export interface MachineProviderAccountsSnapshot {
  machine: string;
  runners: ProviderRunnerAccountStatus[];
  checkedAt: string;
  /** False when the host could not be probed (remote offline, etc.). */
  reachable?: boolean;
}

export interface ProviderAccountsSnapshot {
  machines: MachineProviderAccountsSnapshot[];
  checkedAt: string;
}
