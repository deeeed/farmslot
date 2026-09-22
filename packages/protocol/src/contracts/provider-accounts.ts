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

/** One credential entry; readiness does not establish billing or quota. */
export interface RunnerProviderAccount {
  id: string;
  provider: string;
  label?: string;
  email?: string;
  status: 'configured' | 'ready' | 'not_ready' | 'invalid' | 'unknown';
  authType: 'oauth' | 'api_key' | 'unknown';
  source: 'native-status' | 'credential-store';
}

export interface RunnerAccountInspection {
  command: string;
  description: string;
}

export interface RunnerAccountInventory {
  status: 'available' | 'unavailable' | 'unsupported';
  /** Host default configuration only; not the account used by every active run. */
  scope: 'host-default';
  accounts: RunnerProviderAccount[];
  /** Copy-only command prepared by the runner adapter; never contains credentials. */
  inspection?: RunnerAccountInspection;
  error?: string;
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
  /** Provider-aware, read-only inventory. Older gateways may omit it. */
  inventory?: RunnerAccountInventory;
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
