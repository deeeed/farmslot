// rpc/gateway.ts — gateway self-status: package version + update freshness.
//
// Farmslot ships as a git clone updated via `farmslot update` (fetch + reset to
// origin's default branch). There is no semver release stream, so "a new version
// is available" is expressed as the local HEAD being behind origin/<branch>.

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

export interface GatewayStatusResult {
  /** `@farmslot/gateway` package version. */
  version: string;
  update: GatewayUpdateStatus;
}
