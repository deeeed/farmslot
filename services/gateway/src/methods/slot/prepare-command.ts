import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EXEC_TIMEOUT_EXIT_CODE } from '../../core/exec.js';
import {
  execLocal,
  execOnSlot,
  farmslotRoot,
  isLocal,
  isMissingProjectConfigError,
  loadProjectVars,
  type SlotVars,
} from '../../core/index.js';
import { ORCHESTRATOR_LOCALITY, slotWriteFiles } from '../../core/slot-io.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../../core/tmux.js';
import { withoutNodeReconnectWait } from '../../fleet/node-rpc.js';
import { resolveWorkspaceRoot } from '../../projects/repo-root.js';

import { DEFAULT_GATEWAY_PORT, sanitizePhaseName } from './shared.js';

const PREPARE_POLL_WARNING_THROTTLE_MS = 30_000;
const PREPARE_SENTINEL_POLL_TIMEOUT_MS = 10_000;
const PREPARE_WINDOW_POLL_TIMEOUT_MS = 5_000;
const PREPARE_SCOPE_SENTINEL_MARKER = 'farmslot-prepare-scope';
/** The identity file holds `pgid\tsentinel pid\tscope` (written by the prepare wrapper). */
const PREPARE_IDENTITY_SCOPE_FIELD = 2;
const PREPARE_TAIL_POLL_INTERVAL_MS = 1500;
/**
 * `group_alive <pgid>`: whether any member of the process group is still
 * running. Linux still delivers `kill -0 -PGID` to a zombie, so a killed member
 * its parent has not reaped yet would read as alive. Count only members ps does
 * not report as Z (BSD ps and procps agree).
 */
const PREPARE_GROUP_ALIVE_FN = `group_alive() { ps -A -o pgid= -o stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'; }`;
export const PREPARE_DEPS_TIMEOUT_MS = 90 * 60_000;
export const PREPARE_PREFLIGHT_TIMEOUT_MS = 15 * 60_000;

interface PreparePollWarningState {
  consecutiveErrors: number;
  lastWarningAt: number;
}

export function shouldEmitPreparePollWarning(
  consecutiveErrors: number,
  now: number,
  lastWarningAt: number,
): boolean {
  return consecutiveErrors <= 3 || now - lastWarningAt >= PREPARE_POLL_WARNING_THROTTLE_MS;
}

export function getPrepareSentinelPollTimeoutMs(): number {
  return PREPARE_SENTINEL_POLL_TIMEOUT_MS;
}

export function getPrepareDepsTimeoutMs(): number {
  return PREPARE_DEPS_TIMEOUT_MS;
}

export function getPreparePreflightTimeoutMs(): number {
  return PREPARE_PREFLIGHT_TIMEOUT_MS;
}

export function shouldPreservePrepareWindowOnSuccess(
  phase: string | undefined,
  paneDead: string,
): boolean {
  return phase === 'preflight' && paneDead.trim() === '0';
}

function preparePollErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Human-readable cause for a prepare exit code that came from a killed tmux
 * window. A 128+signal code means the wrapping bash caught a signal (its trap
 * writes the sentinel), i.e. the window was torn down externally — a concurrent
 * prepare/release/recycle or the pre-launch `prepare-*` sweep — rather than the
 * command itself failing. Returns null for ordinary command exit codes.
 */
export function prepareSignalHint(exitCode: number | null): string | null {
  switch (exitCode) {
    case 129:
      return 'prepare window received SIGHUP — the tmux window was killed externally (a concurrent prepare/release/recycle or the pre-launch prepare-* sweep tore it down), not a genuine command failure';
    case 143:
      return 'prepare window received SIGTERM — the tmux window was killed externally, not a genuine command failure';
    default:
      return null;
  }
}

// Emitted on stdout by the cleanup script when it terminates the tracked
// in-flight preflight (the pid from PID_FILE, still alive and confirmed to be a
// preflight process). Recovery reads this to decide whether a post-kill health
// check can be trusted: a slot just stripped of its preflight cannot be declared
// healthy from leftover artifacts. It is intentionally NOT emitted from the
// fallback pgrep sweep — under `bash -c`, that sweep's own while-loop subshell
// matches the pattern embedded in the script's argv, which would self-signal a
// kill that never touched a real prepare process.
const PREPARE_KILLED_MARKER = '__FARMSLOT_KILLED_PREPARE__';

export async function clearStalePrepareProcess(
  vars: SlotVars,
  pidFile: string,
  label: string,
  cleanupPatterns?: string[],
): Promise<boolean> {
  const projectPreflight = `${farmslotRoot}/projects/${vars.projectName}/setup/preflight.sh ${vars.slotId}`;
  const fallbackPatterns = [
    projectPreflight,
    `${vars.remoteRepo}/temp/.agent/preflight.pid`,
    `${vars.remoteRepo}/.agent/preflight.pid`,
    ...(cleanupPatterns ?? []),
  ].filter((p) => p.trim().length > 0);
  const fallbackKills = fallbackPatterns
    .map((pattern) => `kill_matching_trees ${shellQuote(pattern)}`)
    .join('\n');
  const cleanupCmd = `
PID_FILE=${shellQuote(pidFile)}
if [ ! -f "$PID_FILE" ]; then
  PID=""
else
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
fi
kill_tree() {
  local parent="$1"
  local signal="\${2:-TERM}"
  local children
  children=$(pgrep -P "$parent" 2>/dev/null || true)
  for child in $children; do
    kill_tree "$child" "$signal"
  done
  case "$signal" in
    KILL) kill -KILL "$parent" 2>/dev/null || true ;;
    *) kill -TERM "$parent" 2>/dev/null || true ;;
  esac
}
kill_matching_trees() {
  local pattern="$1"
  local pid
  pgrep -f "$pattern" 2>/dev/null | while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    kill_tree "$pid" TERM
    sleep 1
    kill_tree "$pid" KILL
  done
}
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  CMD=$(ps -p "$PID" -o command= 2>/dev/null || true)
  if echo "$CMD" | grep -q 'preflight.sh'; then
    echo ${shellQuote(PREPARE_KILLED_MARKER)}
    kill_tree "$PID" TERM
    sleep 2
    kill_tree "$PID" KILL
  fi
fi
${fallbackKills}
rm -f "$PID_FILE"
`;
  const result = await execOnSlot(vars, cleanupCmd, { cwd: vars.remoteRepo, timeout: 30000 });
  const killed = result.stdout.includes(PREPARE_KILLED_MARKER);
  if (result.exitCode !== 0) {
    console.warn(
      `[prepare] stale ${label} cleanup exited ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
  return killed;
}

export function buildPrepareWindowName(labelPart: string): string {
  return `prepare-${labelPart}`;
}

export function buildPreparePlaceholderCommand(): string {
  // Portable across macOS/BSD and GNU userlands. `sleep infinity` only works on
  // GNU coreutils; on macOS it exits immediately, which removes the placeholder
  // pane before pipe-pane/respawn-pane can attach and turns prepare into an
  // opaque exit-1 failure before the real hook starts.
  return 'while :; do sleep 86400; done';
}

export function prepareSessionTarget(sessionName: string): string {
  return `${sessionName}:`;
}

/**
 * Formats a silence duration as a compact `Xm Ys` / `Ys` string for the deps
 * heartbeat message. Sub-minute silences omit the minute component.
 */
export function formatPrepareSilence(silenceMs: number): string {
  const min = Math.floor(silenceMs / 60_000);
  const sec = Math.floor((silenceMs % 60_000) / 1_000);
  return min > 0 ? `${min}m${sec}s` : `${sec}s`;
}

/**
 * Returns the deps heartbeat message once a command has been silent for at least
 * thresholdMs, or null while output is still recent. Keeps the emit-or-skip
 * decision testable without a live interval.
 */
export function prepareSilenceNotice(silenceMs: number, thresholdMs = 30_000): string | null {
  if (silenceMs < thresholdMs) return null;
  return `Still running… (${formatPrepareSilence(silenceMs)} since last output)`;
}

/**
 * Emits the connection step for a slot. Local slots report a single connect step
 * and never open SSH; remote slots report the SSH check, probe reachability, and
 * throw when the slot cannot be reached. probe is injectable for tests and
 * defaults to the real SSH exec.
 */
export async function ensureSlotReachable(
  vars: SlotVars,
  step: (name: string, detail: string) => void,
  probe: (vars: SlotVars, cmd: string) => Promise<{ exitCode: number }> = execOnSlot,
): Promise<void> {
  if (isLocal(vars.host, vars.machine)) {
    step('connect', `Local slot on ${vars.machine}`);
    return;
  }
  step('ssh', `Checking ${vars.sshTarget}...`);
  const r = await probe(vars, 'echo ok');
  if (r.exitCode !== 0) {
    throw new Error(
      `Cannot reach ${vars.sshTarget}. Next: confirm the slot host is online and SSH is configured ` +
        `(ssh ${vars.sshTarget} echo ok), or point the slot at a local/reachable host and rerun prepare.`,
    );
  }
  step('ssh', `Connected to ${vars.sshTarget}`);
}

function prepareEnsureSessionSnippet(sessionName: string, cwd: string): string {
  return (
    `has-session -t ${shellQuote(sessionName)} 2>/dev/null || ` +
    `"$TMUX_BIN" new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(cwd)}`
  );
}

export function buildPrepareNewWindowCommand(
  sessionName: string,
  windowName: string,
  cwd: string,
  placeholderCommand: string,
): string {
  return tmuxShellSnippet(
    `${prepareEnsureSessionSnippet(sessionName, cwd)}; ` +
      `"$TMUX_BIN" new-window -d -t ${shellQuote(prepareSessionTarget(sessionName))} ` +
      `-n ${shellQuote(windowName)} -c ${shellQuote(cwd)} ${shellQuote(placeholderCommand)}`,
  );
}

/**
 * Kill every window whose name exactly matches `windowName`, addressed by
 * `window_id` rather than by name.
 *
 * tmux refuses name targets when two windows share the same name
 * (`can't find window: prepare-...`). Same-phase prepare retries used to leave
 * that poisoned state behind: the pre-launch sweep skips `prepare-<runId>-*`,
 * a second `new-window -n prepare-<runId>-deps` creates a duplicate, and
 * subsequent `pipe-pane` / `kill-window` by name both fail — surfacing as a
 * fake "yarn install failed" before the real command ever starts.
 *
 * Farmslot prepare window names are generated as `prepare-<runId>-<phase>` and
 * must not contain `:`; the command uses `id:name` as an internal delimiter.
 */
export function buildPrepareKillWindowsByNameCommand(
  sessionName: string,
  windowName: string,
): string {
  return buildPrepareWindowTeardownCommand(
    sessionName,
    `awk -F: -v want=${shellQuote(windowName)} '$2 == want { print $1 ":" $2 }'`,
  );
}

/**
 * Tear down the prepare windows a selector picks: stop each pane's process
 * group, then close the window. Closing only the window SIGHUPs the pane, and a
 * tree that ignores SIGHUP (corepack, yarn) outlives it while still holding the
 * phase's locks. The pane process leads its own group under tmux; a pane that
 * does not is left to the window close.
 *
 * Windows are addressed by their stable `window_id`: a stopped pane can close
 * its window, and with `renumber-windows` a saved index would then name a
 * neighbouring window. Every selected group gets TERM first, so the wrapper's
 * trap runs its cleanup; the groups share one grace period, and survivors are
 * killed before the windows close.
 */
function buildPrepareWindowTeardownCommand(sessionName: string, selectWindows: string): string {
  return tmuxShellSnippet(
    `list-windows -t ${shellQuote(sessionName)} -F '#{window_id}:#{window_name}' 2>/dev/null | ` +
      `${selectWindows} | { ` +
      `ids=''; groups=''; ` +
      `while IFS=: read -r id name; do ` +
      `echo "$id:$name"; ids="$ids $id"; ` +
      `for pane in $("$TMUX_BIN" list-panes -t "$id" -F '#{pane_pid}' 2>/dev/null); do ` +
      `case "$pane" in ''|*[!0-9]*) continue ;; esac; ` +
      `[ "$pane" -gt 1 ] || continue; ` +
      `[ "$(ps -o pgid= -p "$pane" 2>/dev/null | tr -d '[:space:]')" = "$pane" ] || continue; ` +
      `kill -TERM -"$pane" 2>/dev/null && groups="$groups $pane"; ` +
      `done; ` +
      `done; ` +
      // Wait about 2s on the cheap signal probe; it also counts zombies, so the
      // KILL decision uses the zombie-aware check. The lists are split through
      // `$(echo ...)`: remote macOS nodes run this under `zsh -f`, which does
      // not split a bare `$groups`.
      `n=0; while [ "$n" -lt 20 ]; do alive=false; ` +
      `for group in $(echo $groups); do if kill -0 -"$group" 2>/dev/null; then alive=true; fi; done; ` +
      `$alive || break; sleep 0.1; n=$((n+1)); done; ` +
      `${PREPARE_GROUP_ALIVE_FN}; ` +
      `for group in $(echo $groups); do if group_alive "$group"; then kill -KILL -"$group" 2>/dev/null; fi; done; ` +
      `for id in $(echo $ids); do "$TMUX_BIN" kill-window -t "$id" 2>/dev/null || true; done; ` +
      `}`,
  );
}

export function buildPreparePreLaunchSweepCommand(sessionName: string, labelPart: string): string {
  // Reap stale prepare-* windows from other runs, but keep this run's sibling
  // phases (`prepare-<labelPart>` / `prepare-<labelPart>-*`) alive — a later phase must not SIGHUP an
  // in-flight fixtures/deps/preflight window owned by the same prepare.
  // The `id:name` delimiter is safe here because only Farmslot-generated
  // `prepare-*` names are eligible for killing, and prepare names never contain
  // `:`.
  return buildPrepareWindowTeardownCommand(
    sessionName,
    `awk -F: -v keep=${shellQuote(`^prepare-${labelPart}($|-)`)} '$2 ~ /^prepare-/ && $2 !~ keep { print $1 ":" $2 }'`,
  );
}

export function buildPrepareIdentityReapCommand(
  identityPath: string,
  opts: { expectedScope?: string; awaitExit?: boolean } = {},
): string {
  // expectedScope fences the reap to one prepare: a different recorded scope
  // (a successor's preflight) is neither signalled nor removed. awaitExit
  // waits out the group, escalates to SIGKILL, and fails while it survives,
  // keeping the identity so a retry can still find it.
  const expected = opts.expectedScope
    ? [`  if [ "$scope" != ${shellQuote(opts.expectedScope)} ]; then valid=false; foreign=true; fi`]
    : [];
  const awaitExit = opts.awaitExit
    ? [
        `    ${PREPARE_GROUP_ALIVE_FN}`,
        '    n=0; while group_alive "$pgid" && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n+1)); done',
        '    if group_alive "$pgid"; then kill -KILL -"$pgid" 2>/dev/null; sleep 0.2; fi',
        '    if group_alive "$pgid"; then echo "preflight group $pgid survived SIGKILL" >&2; exit 1; fi',
      ]
    : [];
  return [
    `identityfile=${shellQuote(identityPath)}`,
    'foreign=false',
    'identity=""',
    `if [ -f "$identityfile" ]; then`,
    `  identity=$(cat "$identityfile" 2>/dev/null || true)`,
    `  tab=$(printf '\t')`,
    `  pgid=""; sentinel=""; scope=""; rest=""`,
    `  case "$identity" in *"$tab"*) pgid=\${identity%%"$tab"*}; rest=\${identity#*"$tab"} ;; esac`,
    `  case "$rest" in *"$tab"*) sentinel=\${rest%%"$tab"*}; scope=\${rest#*"$tab"} ;; esac`,
    `  valid=false`,
    `  case "$pgid" in ''|*[!0-9]*) ;; *) case "$sentinel" in ''|*[!0-9]*) ;; *) case "$scope" in ''|*[!0-9a-f]*|*"$tab"*) ;; *) if [ "$pgid" -gt 1 ] && [ "$sentinel" -gt 1 ] && [ "\${#scope}" -eq 32 ]; then valid=true; fi ;; esac ;; esac ;; esac`,
    ...expected,
    `  matched=false`,
    `  if $valid; then`,
    `    live_pgid=$(ps -o pgid= -p "$sentinel" 2>/dev/null | tr -d '[:space:]')`,
    `    marker_ok=false; scope_ok=false`,
    `    if [ "$live_pgid" = "$pgid" ]; then`,
    `      sentinel_command=$(ps -ww -p "$sentinel" -o command= 2>/dev/null || true)`,
    `      if printf '%s\n' "$sentinel_command" | tr '[:space:]' '\n' | grep -Fxq -- ${shellQuote(PREPARE_SCOPE_SENTINEL_MARKER)}; then marker_ok=true; fi`,
    `      if printf '%s\n' "$sentinel_command" | tr '[:space:]' '\n' | grep -Fxq -- "$scope"; then scope_ok=true; fi`,
    `    fi`,
    `    if $marker_ok && $scope_ok; then matched=true; fi`,
    `  fi`,
    // No `--` before the group: dash rejects `kill -- -PGID` as an illegal number.
    `  if $matched && kill -TERM -"$pgid" 2>/dev/null; then`,
    `    echo "killed verified preflight group ($pgid)"`,
    ...awaitExit,
    `  fi`,
    `fi`,
    // Remove only the identity this reap read: a successor's, written while
    // the group drained, stays recorded for its own cleanup.
    `if ! $foreign && [ "$(cat "$identityfile" 2>/dev/null || true)" = "$identity" ]; then rm -f "$identityfile"; fi`,
  ].join('\n');
}

export async function resolvePrepareRuntimeDir(projectName: string): Promise<string> {
  try {
    const projectVars = await loadProjectVars(projectName);
    return projectVars.runtimeDir || '.agent';
  } catch (error) {
    if (isMissingProjectConfigError(error)) return '.agent';
    throw error;
  }
}

export function prepareIdentityPath(remoteRepo: string, runtimeDir: string): string {
  return path.posix.join(remoteRepo, runtimeDir || '.agent', 'preflight.identity');
}

/**
 * Stop a slot's recorded prepare scope: the preflight process group and its
 * nohup'd `farmslot-prepare-scope` holder, which outlive an aborted or
 * kept-alive prepare window in the slot repository. Signals only a live group
 * whose scope still matches, so it is a no-op when nothing is recorded, waits
 * for the group to exit, and throws while any of it survives.
 *
 * `stillOwned` fences a caller that holds no slot fence: the recorded scope is
 * read first and reaped only when the caller still owns the slot afterwards,
 * so a successor that claims the slot and records its own preflight is never
 * signalled.
 */
export async function reapSlotPrepareScope(
  vars: SlotVars,
  opts: {
    identityPath?: string;
    expectedScope?: string;
    stillOwned?: () => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const identityPath =
    opts.identityPath ??
    prepareIdentityPath(vars.remoteRepo, await resolvePrepareRuntimeDir(vars.projectName));
  let expectedScope = opts.expectedScope;
  if (opts.stillOwned) {
    const read = await execOnSlot(vars, `cat ${shellQuote(identityPath)} 2>/dev/null; true`, {
      cwd: '/',
      timeout: 5_000,
    });
    if (read.exitCode !== 0)
      throw new Error(`Prepare scope cleanup failed: identity unreadable (exit ${read.exitCode})`);
    const recorded = read.stdout.trim().split('\t')[PREPARE_IDENTITY_SCOPE_FIELD];
    if (!recorded || !(await opts.stillOwned())) return false;
    expectedScope = recorded;
  }
  const result = await execOnSlot(
    vars,
    buildPrepareIdentityReapCommand(identityPath, { expectedScope, awaitExit: true }),
    { cwd: '/', timeout: 15_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Prepare scope cleanup failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    );
  return result.stdout.includes('killed verified preflight group');
}

export function buildPrepareWrappedCommand(
  cmd: string,
  sentinelPath: string,
  scratchDir: string,
  opts?: {
    cwd?: string;
    keepAliveOnSuccess?: boolean;
    workspaceRoot?: string | null;
    prepareScope?: { token: string; identityPath: string };
    /** Recorded beside the exit code so the gateway accepts only this launch's sentinel. */
    attemptNonce?: string;
  },
): string {
  const quotedSentinelPath = shellQuote(sentinelPath);
  const nonceSuffix = opts?.attemptNonce ? ` ${opts.attemptNonce}` : '';
  const writeSentinel = (code: string) =>
    `printf '%s\\n' "${code}${nonceSuffix}" > ${quotedSentinelPath}`;
  const keepAliveOnSuccess = opts?.keepAliveOnSuccess === true;
  // Pack runway scripts default the workspace to $HOME/farmslot when
  // FARMSLOT_WORKSPACE is unset. The prepare window inherits the gateway env,
  // which may not carry that var, so a dev-farm slot would write .runway-resolved
  // and provision artifacts into the base install's workspace. Export the resolved
  // root here so those scripts land under this workspace. resolveWorkspaceRoot
  // returns the inherited value when the env already sets it, keeping this a no-op
  // for an explicitly-set workspace; when no workspace resolves it stays unset and
  // the pack default applies.
  const workspaceExports = opts?.workspaceRoot
    ? [`export FARMSLOT_WORKSPACE=${shellQuote(opts.workspaceRoot)}`]
    : [];
  const prepareScopeSetup = opts?.prepareScope
    ? [
        `mkdir -p ${shellQuote(path.dirname(opts.prepareScope.identityPath))}`,
        buildPrepareIdentityReapCommand(opts.prepareScope.identityPath),
        `export FARMSLOT_PREPARE_SCOPE=${shellQuote(opts.prepareScope.token)}`,
        `nohup sh -c ${shellQuote('while :; do sleep 86400; done')} ${PREPARE_SCOPE_SENTINEL_MARKER} ${shellQuote(opts.prepareScope.token)} >/dev/null 2>&1 &`,
        'FARMSLOT_PREPARE_SENTINEL_PID=$!',
        'export FARMSLOT_PREPARE_SENTINEL_PID',
        `FARMSLOT_PREPARE_PGID=$(ps -o pgid= -p $$ | tr -d '[:space:]')`,
        `case "$FARMSLOT_PREPARE_PGID" in ''|*[!0-9]*) ;; *) printf '%s\t%s\t%s\n' "$FARMSLOT_PREPARE_PGID" "$FARMSLOT_PREPARE_SENTINEL_PID" "$FARMSLOT_PREPARE_SCOPE" > ${shellQuote(opts.prepareScope.identityPath)} ;; esac`,
      ]
    : [];
  return [
    'unset FORCE_COLOR',
    ...workspaceExports,
    `mkdir -p ${shellQuote(scratchDir)} || { ${writeSentinel('1')}; exit 1; }`,
    // tmux 3.7 can ignore -c when its server's cwd was deleted. Establish the
    // phase directory in the child before hooks, Node or scope setup run.
    ...(opts?.cwd
      ? [
          `cd -- ${shellQuote(opts.cwd)} || { echo ${shellQuote(`Prepare working directory unavailable: ${opts.cwd}`)} >&2; ${writeSentinel('1')}; exit 1; }`,
        ]
      : []),
    '__farmslot_kill_tree() {',
    '  local parent="$1"',
    '  local signal="${2:-TERM}"',
    '  local children child',
    '  if [ -n "${FARMSLOT_PREPARE_SENTINEL_PID:-}" ] && [ "$parent" = "$FARMSLOT_PREPARE_SENTINEL_PID" ]; then return; fi',
    '  children=$(pgrep -P "$parent" 2>/dev/null || true)',
    '  for child in $children; do',
    '    __farmslot_kill_tree "$child" "$signal"',
    '  done',
    '  if [ "$parent" != "$$" ]; then',
    '    case "$signal" in',
    '      KILL) kill -KILL "$parent" 2>/dev/null || true ;;',
    '      *) kill -TERM "$parent" 2>/dev/null || true ;;',
    '    esac',
    '  fi',
    '}',
    // A member that left the tree (its parent exited) is still in the pane's
    // process group. Signal the group only when this wrapper leads it, sparing
    // the wrapper and the prepare-scope holder its reap verifies.
    '__farmslot_signal_group() {',
    '  local group member',
    "  group=$(ps -o pgid= -p $$ 2>/dev/null | tr -d '[:space:]')",
    '  [ "$group" = "$$" ] || return 0',
    `  for member in $(ps -A -o pid= -o pgid= 2>/dev/null | awk -v g="$group" -v self="$$" -v keep="\${FARMSLOT_PREPARE_SENTINEL_PID:-}" '$2 == g && $1 != self && $1 != keep { print $1 }'); do`,
    '    kill -"$1" "$member" 2>/dev/null || true',
    '  done',
    '}',
    '__farmslot_cleanup_descendants() {',
    '  __farmslot_kill_tree "$$" TERM',
    '  __farmslot_signal_group TERM',
    '  sleep 2',
    '  __farmslot_kill_tree "$$" KILL',
    '  __farmslot_signal_group KILL',
    '}',
    '__farmslot_signal_exit() {',
    '  local code="$1"',
    '  trap - HUP INT TERM',
    '  __farmslot_cleanup_descendants',
    `  ${writeSentinel('$code')}`,
    '  sleep 1',
    '  exit "$code"',
    '}',
    ...prepareScopeSetup,
    "trap '__farmslot_signal_exit 129' HUP",
    "trap '__farmslot_signal_exit 130' INT",
    "trap '__farmslot_signal_exit 143' TERM",
    // Subshell, not brace group: hooks that end in `exec foo` (e.g. to forward
    // signals to the real binary) would otherwise replace this wrapping bash
    // entirely, skipping the sentinel write below and stranding prepare with no
    // exit code — gateway then reports "prepare failed" even on clean runs.
    // Background plus `wait`: bash defers a trap until a foreground child
    // returns, so a closed window's tree kept running and kept its phase lock.
    // `wait` returns as soon as a trapped signal arrives. The explicit stdin
    // keeps the pane's terminal, which an asynchronous command would otherwise
    // trade for /dev/null. An asynchronous command also starts with SIGINT
    // ignored, so Ctrl-C in the pane reaches the command through the INT
    // trap's TERM cleanup rather than directly.
    '(',
    cmd,
    ') <&0 &',
    'wait "$!"',
    '__farmslot_status=$?',
    'if [ "$__farmslot_status" -ne 0 ]; then',
    '  __farmslot_cleanup_descendants',
    'fi',
    // After the child command exits, the sentinel must report that real status.
    // A later tmux cleanup can send SIGHUP during the drain sleep; if the traps
    // stay armed, that late signal overwrites a successful phase with 129.
    'trap - HUP INT TERM',
    writeSentinel('$__farmslot_status'),
    'sleep 1',
    // On a successful preflight, keep this wrapping bash alive so the tmux pane
    // stays open. Long-running dev servers spawned by the hook (e.g. `expo start &`)
    // share the pane's pty; if the pane closes they receive SIGHUP from the kernel
    // and die. Holding the pane open keeps the dev server's pty alive and lets
    // shouldPreservePrepareWindowOnSuccess (which checks `pane_dead`) actually fire
    // and skip the kill-window. Next prepare's "stale prepare-*" sweep reaps this.
    ...(keepAliveOnSuccess
      ? [
          'if [ "$__farmslot_status" -eq 0 ]; then',
          '  exec sh -c "while :; do sleep 86400; done"',
          'fi',
        ]
      : []),
    'exit "$__farmslot_status"',
  ].join('\n');
}

/**
 * The exit code a prepare sentinel records for this launch. A sentinel without
 * this launch's nonce belongs to another launch and is not a result.
 */
export function parsePrepareSentinel(content: string, attemptNonce: string): number | null {
  const [code, nonce] = content.trim().split(/\s+/);
  if (!code || nonce !== attemptNonce) return null;
  const parsed = Number.parseInt(code, 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * Remove the sentinels and staged scripts of earlier launches of one prepare
 * phase, including the fixed-path pair of gateways that predate per-launch
 * sentinels. The nonce shape keeps a sibling phase's files out of the match.
 * `find`, not a glob: remote macOS nodes run commands under `zsh -f`, which
 * aborts the whole command when a glob matches nothing.
 */
export function buildPrepareStaleLaunchCleanupCommand(
  scratchDir: string,
  phaseFileName: string,
): string {
  const nonce = '[0-9a-f]'.repeat(12);
  const names = ['.exit', `-${nonce}.exit`, '.sh', `-${nonce}.sh`]
    .map((suffix) => `-name ${shellQuote(`${phaseFileName}${suffix}`)}`)
    .join(' -o ');
  return `find ${shellQuote(scratchDir)} -maxdepth 1 -type f \\( ${names} \\) -exec rm -f -- {} +`;
}

export function buildDevServerPortCleanup(
  devServerPort: string | undefined,
  slotIsLocal: boolean,
  gatewayPort = Number(process.env.GATEWAY_PORT) || DEFAULT_GATEWAY_PORT,
): { command: string | null; skippedReason: string | null } {
  const rawPort = (devServerPort ?? '').trim();
  if (!rawPort) return { command: null, skippedReason: null };
  if (!/^\d+$/.test(rawPort)) {
    return { command: null, skippedReason: `Invalid dev-server port '${rawPort}'` };
  }
  const port = Number(rawPort);
  if (slotIsLocal && port === gatewayPort) {
    return { command: null, skippedReason: `Skipped dev-server cleanup for gateway port ${port}` };
  }
  return {
    command: `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null; true`,
    skippedReason: null,
  };
}

/**
 * Run a prepare command inside a window of the slot's long-running tmux session.
 *
 * The slot's tmux session (e.g. `mm-2`) is the operator-facing surface for that
 * slot — workers already attach windows there during dispatch. Prepare gets its
 * own `prepare-<label>` window inside the same session so operators who
 * `tmux attach -t mm-2` see the prepare run alongside any worker windows from
 * prior flows. One session per slot, one prepare window per flow invocation.
 *
 * Why tmux at all (not raw spawn): provides a real PTY, so TTY-detection tools
 * like Listr2 / execa-wrapped pod install behave the same as in an interactive
 * shell. The companion FORCE_COLOR strip in core/exec.ts is what fixes the
 * VisionCamera worklets-core spec failure; tmux is what gives operators a live
 * attach point and a stable PTY for any future TTY-only tooling.
 *
 * Output: tmux `pipe-pane` streams the prepare window's content to logPath, and
 * a parallel tail polls logPath for fresh bytes to forward to opts.onOutput.
 */
export async function runPrepareCommand(
  vars: SlotVars,
  logPath: string,
  cmd: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    onOutput?: (stream: string, data: string) => void;
    tailPollIntervalMs?: number;
    signal?: AbortSignal;
    windowLabel?: string;
    phase?: string;
    forceLocal?: boolean;
    /** Probes preserve retained preflight panes and reap only their own phase window. */
    preserveOtherPrepareWindows?: boolean;
    prepareScope?: { token: string; identityPath: string };
  },
): Promise<import('../../core/exec.js').ExecResult> {
  const slotIsLocal = isLocal(vars.host, vars.machine);
  const useLocal = opts?.forceLocal === true;
  const slotSession = await resolveTmuxSession(vars.slotId, vars, { strict: true }).catch(
    () => vars.session || vars.slotId,
  );
  const sessionName = useLocal && !slotIsLocal ? `${slotSession}-orch` : slotSession;
  const exec = useLocal
    ? (c: string, eopts?: { cwd?: string; timeout?: number }) =>
        execLocal(c, { cwd: eopts?.cwd, timeout: eopts?.timeout })
    : (c: string, eopts?: { cwd?: string; timeout?: number }) =>
        execOnSlot(vars, c, { cwd: eopts?.cwd, timeout: eopts?.timeout });
  const windowCwd = useLocal && !slotIsLocal ? farmslotRoot : vars.remoteRepo;
  // Labels form both the tmux window target and staged script path.
  const rawLabel = (opts?.windowLabel ?? '').trim();
  const labelPart = /^[A-Za-z0-9_-]+$/.test(rawLabel) ? rawLabel : Date.now().toString();
  const phaseName = opts?.phase ? sanitizePhaseName(opts.phase) : '';
  const windowName = buildPrepareWindowName(phaseName ? `${labelPart}-${phaseName}` : labelPart);
  const target = `${sessionName}:${windowName}`;
  // Sentinel + remote log live on the host where tmux runs: the slot host by
  // default, or the orchestrator when forceLocal is set for orchestrator-only
  // scripts. Critical for remote slots: tmux pipe-pane writes on that host, so
  // the target path must exist there.
  const slotHostScratchDir = '/tmp/farmslot-prepare';
  const phasePart = '';
  const phaseFileName = `${sessionName}-${windowName}${phasePart}`;
  const phaseBase = `${slotHostScratchDir}/${phaseFileName}`;
  // Each launch owns its sentinel and staged script. A tree left by an earlier
  // launch of this phase (a re-driven prepare after a gateway restart) writes
  // its late exit code to its own sentinel, never into this launch's result.
  const attemptNonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const sentinelPath = `${phaseBase}-${attemptNonce}.exit`;
  const slotHostLogPath = `${phaseBase}.log`;
  // Trailing `sleep 1` flushes pipe-pane's final bytes before bash exits. Do not
  // use tmux `remain-on-exit` for prepare panes: prepare output is already
  // streamed into the run log, and a dead prepare pane is not an actionable
  // operator surface. Finished prepare windows must either be gone or still own
  // a live process.
  //
  // `unset FORCE_COLOR` here is mandatory: tmux servers spawned by an earlier
  // `yarn dev` carry FORCE_COLOR=3 in their env, and new windows inherit that
  // regardless of the gateway's own env. Some project tooling (e.g. example-mobile
  // VisionCamera podspec) does `output.strip == "undefined"` against `node --print`
  // results, which gets ANSI-wrapped under FORCE_COLOR and silently breaks pod
  // install. The companion strip in core/exec.ts only protects gateway-direct
  // execLocal callers, not commands launched inside an existing tmux pane.
  const wrappedCmd = buildPrepareWrappedCommand(cmd, sentinelPath, slotHostScratchDir, {
    cwd: windowCwd,
    keepAliveOnSuccess: opts?.phase === 'preflight',
    workspaceRoot: resolveWorkspaceRoot(),
    attemptNonce,
    ...(opts?.prepareScope ? { prepareScope: opts.prepareScope } : {}),
  });
  // Stage the wrapped command in a temp script so tmux respawn-pane can exec
  // bash directly against the file. Necessary because tmux runs respawn-pane's
  // shell-command through `default-shell` (often /bin/zsh on macOS), and zsh's
  // parser chokes on the bash subshell syntax `(...)` we use for sentinel
  // capture. Writing to a script keeps zsh out of the loop entirely.
  const wrappedScriptPath = `${phaseBase}-${attemptNonce}.sh`;
  // Ensure session exists (idle slots may not have one yet) and add the prepare window.
  // tmuxShellSnippet handles the PATH-fallback for remote ssh shells where /opt/homebrew/bin
  // isn't on $PATH by default.
  const ensureSessionCmd = tmuxShellSnippet(prepareEnsureSessionSnippet(sessionName, windowCwd));
  const placeholderCmd = buildPreparePlaceholderCommand();
  // Two-phase pane lifecycle: open a dormant pane first (sleep placeholder),
  // attach pipe-pane, then respawn-pane with the real cmd.
  // Without this split, a wrappedCmd that fast-fails (missing binary, shell
  // parse error) can exit before pipe-pane attaches and the diagnostic output
  // is lost — exactly the opaque-prepare-failure class this whole rewrite is
  // meant to eliminate.
  const newWindowCmd = buildPrepareNewWindowCommand(
    sessionName,
    windowName,
    windowCwd,
    placeholderCmd,
  );
  const pipeCmd = tmuxShellSnippet(
    `pipe-pane -t ${shellQuote(target)} -O 'cat >> ${shellQuote(slotHostLogPath)}'`,
  );
  const respawnCmd = tmuxShellSnippet(
    `respawn-pane -k -t ${shellQuote(target)} -c ${shellQuote(windowCwd)} ` +
      `bash ${shellQuote(wrappedScriptPath)}`,
  );

  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(
    logPath,
    `$ ${cmd}\n[tmux] session=${sessionName} window=${windowName} target=${target}\n` +
      (opts?.phase ? `[tmux] phase=${opts.phase}\n` : '') +
      `[tmux] slot-host-log=${slotHostLogPath} (tail-streamed back to gateway here)\n` +
      `[tmux] attach with: tmux attach -t ${sessionName} (then Ctrl-b w to pick the window)\n`,
    'utf-8',
  );
  const failSetup = async (stage: string, result: import('../../core/exec.js').ExecResult) => {
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    await appendFile(logPath, `\n[tmux] ${stage} failed: ${detail}\n`);
    return { stdout: '', stderr: `${stage} failed: ${detail}`, exitCode: result.exitCode || 1 };
  };

  const ensureR = await exec(ensureSessionCmd, { cwd: opts?.cwd, timeout: 15_000 });
  if (ensureR.exitCode !== 0) {
    return failSetup('tmux ensure-session', ensureR);
  }
  // Pre-launch cleanup: kill stale prepare-* windows from prior runs (gateway restart,
  // aborted run, orphaned cleanup, warm keep-alive preflight panes). Active prepare
  // phases use phase-scoped windows such as `prepare-<runId8>-fixtures`.
  //
  // Exclude THIS run's own windows (`prepare-<labelPart>-*`): a same-run retry or a
  // later phase must never SIGHUP a sibling window an in-flight phase still owns.
  // `activePrepareSlots` only guards within one gateway process, so we also echo
  // every reaped window — if a sweep ever tears down another gateway's live prepare
  // window, that shows up in the log as the culprit (pairs with the 129/143 signal
  // hint recovered on the victim side).
  const sweepR = opts?.preserveOtherPrepareWindows
    ? undefined
    : await exec(buildPreparePreLaunchSweepCommand(sessionName, labelPart), {
        cwd: opts?.cwd,
        timeout: 15_000,
      }).catch(() => undefined);
  const reaped = sweepR?.stdout?.trim();
  if (reaped) {
    console.warn(
      `[prepare] pre-launch sweep reaped stale prepare windows on ${sessionName}: ${reaped
        .split(/\r?\n/)
        .filter(Boolean)
        .join(', ')}`,
    );
  }
  // Same-phase retry orphans: the sweep above preserves `prepare-<labelPart>-*`, so a
  // failed deps/preflight attempt can leave a placeholder window with THIS exact name.
  // Reap that name by index before opening a new one — otherwise tmux creates a
  // duplicate and every later name-targeted command (`pipe-pane`, `kill-window`) fails.
  const samePhaseR = await exec(buildPrepareKillWindowsByNameCommand(sessionName, windowName), {
    cwd: opts?.cwd,
    timeout: 15_000,
  });
  if (samePhaseR.exitCode !== 0) {
    return failSetup('tmux reap same-phase prepare windows', samePhaseR);
  }
  const samePhaseReaped = samePhaseR.stdout.trim();
  if (samePhaseReaped) {
    console.warn(
      `[prepare] pre-launch reaped same-phase prepare window(s) on ${sessionName}: ${samePhaseReaped
        .split(/\r?\n/)
        .filter(Boolean)
        .join(', ')}`,
    );
  }
  // Pre-create the slot-host scratch dir + truncate any prior log so pipe-pane has a
  // clean target. We do this BEFORE launching the window so pipe-pane doesn't race the
  // mkdir inside the wrapped cmd. Also stage the wrapped script here so the respawn
  // call can exec it directly without going through a host-shell parser.
  const stageTimeout = 10_000;
  let stagedCommand = wrappedCmd;
  if (!useLocal && !slotIsLocal && wrappedCmd.includes('~/farmslot-node')) {
    const { NodeSupportPendingError, resolveRemoteFarmCommand } =
      await import('../../node-support/remote-command.js');
    try {
      stagedCommand = await resolveRemoteFarmCommand(vars, wrappedCmd, { budgetMs: stageTimeout });
    } catch (error) {
      if (!(error instanceof NodeSupportPendingError)) throw error;
      return failSetup('stage prepare script', {
        stdout: '',
        stderr: error.message,
        exitCode: EXEC_TIMEOUT_EXIT_CODE,
      });
    }
  }
  const stageR = await exec(
    `mkdir -p ${shellQuote(slotHostScratchDir)} && ${buildPrepareStaleLaunchCleanupCommand(slotHostScratchDir, phaseFileName)} && : > ${shellQuote(slotHostLogPath)}`,
    { cwd: opts?.cwd, timeout: stageTimeout },
  );
  if (stageR.exitCode !== 0) {
    return failSetup('stage prepare script', stageR);
  }
  // The file transport keeps task inputs out of shell argv, including the
  // node-support command wrapper used by remote slots.
  await slotWriteFiles(useLocal ? ORCHESTRATOR_LOCALITY : vars, slotHostScratchDir, [
    {
      path: path.posix.basename(wrappedScriptPath),
      content: Buffer.from(`${stagedCommand}\n`).toString('base64'),
      mode: 0o600,
    },
  ]);
  const launchR = await exec(newWindowCmd, { cwd: opts?.cwd, timeout: 30_000 });
  if (launchR.exitCode !== 0) {
    return failSetup('tmux new-window', launchR);
  }
  // Explicitly disable remain-on-exit. Older gateway builds enabled it for
  // prepare postmortems, but that left dead panes behind and the canonical
  // postmortem source is the prepare log plus slot-host log.
  const remainR = await exec(
    tmuxShellSnippet(`set-window-option -t ${shellQuote(target)} remain-on-exit off`),
    { cwd: opts?.cwd, timeout: 10_000 },
  );
  const killPrepareWindowsByName = () =>
    withoutNodeReconnectWait(() =>
      exec(buildPrepareKillWindowsByNameCommand(sessionName, windowName), {
        timeout: 10_000,
      }),
    );
  if (remainR.exitCode !== 0) {
    await killPrepareWindowsByName();
    return failSetup('tmux remain-on-exit', remainR);
  }
  const pipeR = await exec(pipeCmd, { cwd: opts?.cwd, timeout: 10_000 });
  if (pipeR.exitCode !== 0) {
    await killPrepareWindowsByName();
    return failSetup('tmux pipe-pane', pipeR);
  }
  // A cancel that landed during setup must not launch the wrapper: its
  // prepare-scope holder would start after the canceller's reap had run.
  if (opts?.signal?.aborted) {
    await killPrepareWindowsByName();
    return { stdout: '', stderr: 'aborted', exitCode: 130 };
  }
  // Now that pipe-pane is attached, respawn the pane with the real wrapped
  // command. The dormant placeholder loop is killed by `-k`; pipe-pane
  // subscription survives since it's bound to the pane, not the process.
  const respawnR = await exec(respawnCmd, { cwd: opts?.cwd, timeout: 15_000 });
  if (respawnR.exitCode !== 0) {
    await killPrepareWindowsByName();
    return failSetup('tmux respawn-pane', respawnR);
  }

  const pollWarnings: PreparePollWarningState = { consecutiveErrors: 0, lastWarningAt: 0 };
  const recordPollError = async (stage: string, error: unknown): Promise<void> => {
    pollWarnings.consecutiveErrors += 1;
    const now = Date.now();
    const msg = preparePollErrorMessage(error);
    if (
      !shouldEmitPreparePollWarning(pollWarnings.consecutiveErrors, now, pollWarnings.lastWarningAt)
    ) {
      return;
    }
    pollWarnings.lastWarningAt = now;
    const warning =
      `\n[tmux] ${stage} poll unavailable (${pollWarnings.consecutiveErrors} consecutive): ${msg}; ` +
      'prepare command is still governed by tmux sentinel/timeout\n';
    console.warn(`[prepare] ${warning.trim()}`);
    try {
      await appendFile(logPath, warning);
    } catch (appendError) {
      console.warn(
        `[prepare] failed to append ${stage} poll warning to ${logPath}: ${preparePollErrorMessage(appendError)}`,
      );
    }
  };
  const markPollOk = (): void => {
    pollWarnings.consecutiveErrors = 0;
  };
  const pollExec = async (
    stage: string,
    command: string,
    timeout: number,
  ): Promise<import('../../core/exec.js').ExecResult | null> => {
    try {
      const result = await exec(command, { timeout });
      markPollOk();
      return result;
    } catch (error) {
      // Polling is observational only: the real prepare command is running in
      // tmux and reports completion through the sentinel file. A transient node
      // RPC timeout while checking the sentinel/window must not turn a still
      // running (or already successful) command into a failed run.
      await recordPollError(stage, error);
      return null;
    }
  };

  // Tail the slot-host log and stream new bytes back to (a) gateway logPath via appendFile
  // and (b) onOutput observers (e.g. preflight's progress-marker parser). Tail errors are
  // observability-only — never fail the prepare on a tail glitch.
  let lastSize = 0;
  const readTailChunk = async (): Promise<void> => {
    const sizeR = await exec(`wc -c < ${shellQuote(slotHostLogPath)} 2>/dev/null`, {
      timeout: 5_000,
    });
    const size = Number.parseInt(sizeR.stdout.trim(), 10);
    if (!Number.isFinite(size) || size <= lastSize) return;
    const chunkR = await exec(`tail -c +${lastSize + 1} ${shellQuote(slotHostLogPath)}`, {
      timeout: 10_000,
    });
    if (chunkR.stdout) {
      void appendFile(logPath, chunkR.stdout);
      opts?.onOutput?.('stdout', chunkR.stdout);
    }
    lastSize = size;
  };
  let tailAborted = false;
  const tailPromise = (async () => {
    while (!tailAborted) {
      try {
        await readTailChunk();
      } catch (err) {
        // Best-effort observability; one warn per glitch is fine.
        console.warn('[prepare] tail-poll iteration failed', (err as Error).message);
      }
      await new Promise((r) =>
        setTimeout(r, opts?.tailPollIntervalMs ?? PREPARE_TAIL_POLL_INTERVAL_MS),
      );
    }
  })();

  // Kill by window_id, not by name: duplicate same-named prepare windows make
  // `kill-window -t session:name` return "can't find window" and leave orphans.
  const killWindow = () => killPrepareWindowsByName();

  // When the tmux window disappears WITHOUT a sentinel yet, a `kill-window`
  // SIGHUPs the wrapper, whose HUP trap runs __farmslot_cleanup_descendants
  // (sleep 2) + sleep 1 BEFORE writing 129. So the sentinel lands ~3s after the
  // window is already gone. Poll a few more seconds to recover the REAL signal
  // code (129 SIGHUP / 143 SIGTERM) instead of masking every external kill as a
  // generic "exit 1" preflight failure.
  const SENTINEL_RECOVERY_TIMEOUT_MS = 6_000;
  // Short per-read timeout so the recovery stays within its ~6s wall-clock
  // bound: the sentinel is a tiny local file, so a read that hasn't returned in
  // 2s is a stuck exec, not a slow one — let the loop retry instead of letting a
  // single read consume the whole budget.
  const SENTINEL_RECOVERY_POLL_TIMEOUT_MS = 2_000;
  const recoverSentinelAfterWindowGone = async (): Promise<number> => {
    const deadline = Date.now() + SENTINEL_RECOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const r = await pollExec(
        'sentinel-recovery',
        `test -f ${shellQuote(sentinelPath)} && cat ${shellQuote(sentinelPath)}`,
        SENTINEL_RECOVERY_POLL_TIMEOUT_MS,
      );
      const recovered = r && r.exitCode === 0 ? parsePrepareSentinel(r.stdout, attemptNonce) : null;
      if (recovered !== null) return recovered;
      await new Promise((res) => setTimeout(res, 500));
    }
    return 1;
  };

  // Poll for the sentinel file (cmd exit code). Honour timeout + abort signal.
  const startTime = Date.now();
  const pollInterval = 1500;
  let exitCode: number | null = null;
  while (true) {
    if (opts?.signal?.aborted) {
      tailAborted = true;
      try {
        await killWindow();
      } finally {
        await tailPromise.catch(() => undefined);
      }
      // Closing the window leaves the nohup'd holder (and anything else in the
      // group that ignores SIGHUP) running in the slot repository.
      if (opts.prepareScope && !useLocal) {
        const prepareScope = opts.prepareScope;
        await withoutNodeReconnectWait(() =>
          reapSlotPrepareScope(vars, {
            identityPath: prepareScope.identityPath,
            expectedScope: prepareScope.token,
          }),
        ).catch((error: unknown) =>
          console.warn(
            `[prepare] aborted prepare scope cleanup failed: ${preparePollErrorMessage(error)}`,
          ),
        );
      }
      return { stdout: '', stderr: 'aborted', exitCode: 130 };
    }
    if (opts?.timeout && Date.now() - startTime > opts.timeout) {
      tailAborted = true;
      try {
        await killWindow();
      } finally {
        await tailPromise.catch(() => undefined);
      }
      return { stdout: '', stderr: `timed out after ${opts.timeout}ms`, exitCode: 124 };
    }
    const checkR = await pollExec(
      'sentinel',
      `test -f ${shellQuote(sentinelPath)} && cat ${shellQuote(sentinelPath)}`,
      PREPARE_SENTINEL_POLL_TIMEOUT_MS,
    );
    const recorded =
      checkR && checkR.exitCode === 0 ? parsePrepareSentinel(checkR.stdout, attemptNonce) : null;
    if (recorded !== null) {
      exitCode = recorded;
      break;
    }
    // If the prepare window died without writing a sentinel, treat as failure rather than spin.
    // This checks list-windows output instead of targeting `session:windowName`; duplicate
    // prepare names are the failure mode this command path recovers from, and tmux name
    // targets become ambiguous in that state.
    const windowAliveR = await pollExec(
      'window-alive',
      tmuxShellSnippet(
        `list-windows -t ${shellQuote(sessionName)} -F '#{window_name}' 2>/dev/null | grep -Fxq ${shellQuote(windowName)}`,
      ),
      PREPARE_WINDOW_POLL_TIMEOUT_MS,
    );
    if (!checkR || !windowAliveR) {
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }
    const windowAlive = windowAliveR.exitCode === 0;
    if (!windowAlive) {
      exitCode = await recoverSentinelAfterWindowGone();
      break;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // Drain final pipe-pane output before deciding whether to keep the window. The
  // grace-sleep waits out the wrappedCmd's trailing `sleep 1`, then a forced final
  // tail read captures any bytes that landed inside the previous polling window —
  // without this, failure messages emitted in the last ~1.5s are lost.
  await new Promise((r) => setTimeout(r, 1000));
  await readTailChunk().catch((err) => {
    console.warn('[prepare] final tail-drain failed', (err as Error).message);
  });
  tailAborted = true;
  await tailPromise.catch(() => undefined);

  if (exitCode === 0) {
    let paneDead = '1';
    try {
      const paneDeadR = await exec(
        tmuxShellSnippet(`display-message -p -t ${shellQuote(target)} '#{pane_dead}'`),
        {
          timeout: 5_000,
        },
      );
      paneDead = paneDeadR.stdout;
    } catch (err) {
      // A missing tmux target after a successful command is recoverable: the
      // pane is already gone, so the safe cleanup behavior is the same as a
      // dead pane. Record it in the prepare log rather than hiding the reason.
      await appendFile(
        logPath,
        `\n[tmux] unable to inspect pane liveness for ${target}; treating as dead: ${(err as Error).message}\n`,
      );
    }
    if (shouldPreservePrepareWindowOnSuccess(opts?.phase, paneDead)) {
      await appendFile(
        logPath,
        `\n[tmux] cmd exit=0; preserving live ${opts?.phase} pane ${target} because it still owns descendant processes (dev server).\n`,
      );
    } else {
      await killWindow();
    }
    await exec(
      `rm -f ${shellQuote(sentinelPath)} ${shellQuote(wrappedScriptPath)} ${shellQuote(slotHostLogPath)}`,
      {
        timeout: 5_000,
      },
    ).catch(() => undefined);
  } else {
    // Always kill failed/aborted/timeout prepare windows. On failure we keep the
    // slot-host log + sentinel on disk for later inspection.
    await killWindow();
    const hint = prepareSignalHint(exitCode);
    await appendFile(
      logPath,
      `\n[tmux] cmd exit=${exitCode}; prepare window cleaned up.\n` +
        (hint ? `      ${hint}\n` : '') +
        `      Slot-host scrollback log: ${slotHostLogPath}\n` +
        `      Sentinel: ${sentinelPath}\n`,
    );
    if (hint) console.warn(`[prepare] ${target}: ${hint}`);
  }

  return { stdout: '', stderr: prepareSignalHint(exitCode) ?? '', exitCode: exitCode ?? 1 };
}
