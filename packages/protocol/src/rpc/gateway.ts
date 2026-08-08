// rpc/gateway.ts — gateway self-status: package version + update freshness.
//
// Farmslot ships as a git clone updated via `farmslot update` (fetch + reset to
// origin's default branch). There is no semver release stream, so "a new version
// is available" is expressed as the local HEAD being behind origin/<branch>.

/** Lightweight authenticated liveness response with no filesystem or network I/O. */
export interface GatewayPingResult {
  ok: true;
  serverTimeMs: number;
}

export interface GatewayStatusParams {
  /** Force a fresh `git fetch` instead of returning the cached freshness snapshot. */
  refresh?: boolean;
}

export interface GatewayUpdateStatus {
  /** True when the local clone is behind the tracked remote branch (commitsBehind > 0). */
  updateAvailable: boolean;
  /** Commits the local HEAD is behind origin/<branch>. */
  commitsBehind: number;
  /** Commits the local HEAD is ahead of origin/<branch> (local edits / detached work). */
  commitsAhead: number;
  /** Remote default branch the freshness check compares against. */
  branch: string;
  /** Short SHA of the local HEAD, or '' if it could not be read. */
  localSha: string;
  /** Short SHA of origin/<branch>, or null when the remote ref is unknown. */
  remoteSha: string | null;
  /** ISO timestamp of the last successful `git fetch`, or null if it never succeeded. */
  lastChecked: string | null;
  /** Command the operator runs to update (e.g. `farmslot update`). */
  updateCommand: string;
  /** Set when the freshness check could not complete (offline, not a git checkout, …). */
  error: string | null;
}

export interface GatewayReleaseNotes {
  version: string;
  date?: string | null;
  items: string[];
}

/** How the gateway process is bound — relevant for LAN/Tailscale Companion pairing. */
export interface GatewayListenInfo {
  /** Normalized bind host (`0.0.0.0` when all interfaces). */
  host: string;
  port: number;
  /** False when bound to loopback only — QR LAN URLs will not reach phones on the network. */
  remotePairingAllowed: boolean;
}

export interface GatewayStatusResult {
  /** `@farmslot/gateway` package version. */
  version: string;
  update: GatewayUpdateStatus;
  /** Operator-facing notes from the latest gateway release cut, when present. */
  releaseNotes?: GatewayReleaseNotes;
  /** Current gateway listen/bind address for remote pairing diagnostics. */
  listen?: GatewayListenInfo;
  capabilities?: {
    experimentalWorkerHistory?: boolean;
  };
}

export type GatewayDoctorSectionId =
  | 'gateway'
  | 'workspace'
  | 'capture'
  | 'browser'
  | 'simulator'
  | 'android';

export interface GatewayDoctorSectionDefinition {
  id: GatewayDoctorSectionId;
  label: string;
  description: string;
}

export interface GatewayDoctorParams {
  /**
   * Omit or set true to run the requested doctor sections.
   * Set false to return the gateway-owned section catalog without running checks.
   * Useful for progressive UIs that need to render the report skeleton before
   * requesting section results.
   */
  run?: boolean;
  /** Run only one doctor section. Omit sectionId/sectionIds to run every section. */
  sectionId?: GatewayDoctorSectionId;
  /** Run multiple specific sections in gateway-defined order. */
  sectionIds?: GatewayDoctorSectionId[];
}

export interface GatewayDoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  warn?: boolean;
  detail: string;
  hint?: string;
}

export interface GatewayDoctorSection {
  id: GatewayDoctorSectionId;
  label: string;
  checks: GatewayDoctorCheck[];
}

export type GatewayDoctorSectionStatus = 'pending' | 'running' | 'complete' | 'error';

/**
 * Progressive doctor section state shared by gateway-aware clients.
 *
 * The gateway owns section identity, labels, and report payloads. Clients may
 * update `status`, `error`, and `checkedAt` while requesting sections
 * incrementally, but should not invent a parallel section model.
 */
export interface GatewayDoctorSectionReport extends GatewayDoctorSectionDefinition {
  status: GatewayDoctorSectionStatus;
  section: GatewayDoctorSection | null;
  error: string;
  checkedAt: string | null;
}

export interface GatewayDoctorResult {
  generatedAt: string;
  availableSections: GatewayDoctorSectionDefinition[];
  requestedSectionIds: GatewayDoctorSectionId[];
  summary: {
    ok: number;
    warn: number;
    fail: number;
  };
  sections: GatewayDoctorSection[];
  identityState?:
    | 'solo-mode'
    | 'never-latched-non-loopback'
    | 'activated-with-admin'
    | 'activated-without-admin';
}
