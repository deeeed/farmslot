import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execLocal, execOnSlot, farmslotRoot, isLocal, type SlotVars } from '../../core/index.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../../core/tmux.js';

import { DEFAULT_GATEWAY_PORT, sanitizePhaseName } from './shared.js';

const PREPARE_POLL_WARNING_THROTTLE_MS = 30_000;
const PREPARE_SENTINEL_POLL_TIMEOUT_MS = 10_000;
const PREPARE_WINDOW_POLL_TIMEOUT_MS = 5_000;
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

export async function clearStalePrepareProcess(
  vars: SlotVars,
  pidFile: string,
  label: string,
  cleanupPatterns?: string[],
): Promise<void> {
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
    kill_tree "$PID" TERM
    sleep 2
    kill_tree "$PID" KILL
  fi
fi
${fallbackKills}
rm -f "$PID_FILE"
`;
  const result = await execOnSlot(vars, cleanupCmd, { cwd: vars.remoteRepo, timeout: 30000 });
  if (result.exitCode === 0) return;
  console.warn(
    `[prepare] stale ${label} cleanup exited ${result.exitCode}: ${result.stderr || result.stdout}`,
  );
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

export function buildPrepareWrappedCommand(
  cmd: string,
  sentinelPath: string,
  scratchDir: string,
  opts?: { keepAliveOnSuccess?: boolean },
): string {
  const quotedSentinelPath = shellQuote(sentinelPath);
  const keepAliveOnSuccess = opts?.keepAliveOnSuccess === true;
  return [
    'unset FORCE_COLOR',
    `mkdir -p ${shellQuote(scratchDir)} || { echo 1 > ${quotedSentinelPath}; exit 1; }`,
    '__farmslot_kill_tree() {',
    '  local parent="$1"',
    '  local signal="${2:-TERM}"',
    '  local children child',
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
    '__farmslot_cleanup_descendants() {',
    '  __farmslot_kill_tree "$$" TERM',
    '  sleep 2',
    '  __farmslot_kill_tree "$$" KILL',
    '}',
    '__farmslot_signal_exit() {',
    '  local code="$1"',
    '  trap - HUP INT TERM',
    '  __farmslot_cleanup_descendants',
    `  echo "$code" > ${quotedSentinelPath}`,
    '  sleep 1',
    '  exit "$code"',
    '}',
    "trap '__farmslot_signal_exit 129' HUP",
    "trap '__farmslot_signal_exit 130' INT",
    "trap '__farmslot_signal_exit 143' TERM",
    // Subshell, not brace group: hooks that end in `exec foo` (e.g. to forward
    // signals to the real binary) would otherwise replace this wrapping bash
    // entirely, skipping the sentinel write below and stranding prepare with no
    // exit code — gateway then reports "prepare failed" even on clean runs.
    '(',
    cmd,
    ')',
    '__farmslot_status=$?',
    'if [ "$__farmslot_status" -ne 0 ]; then',
    '  __farmslot_cleanup_descendants',
    'fi',
    `echo "$__farmslot_status" > ${quotedSentinelPath}`,
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
    command: `lsof -ti :${port} 2>/dev/null | xargs kill 2>/dev/null; true`,
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
    signal?: AbortSignal;
    windowLabel?: string;
    phase?: string;
    forceLocal?: boolean;
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
  // Reject empty / whitespace / unsafe labels: they break tmux window targeting
  // (`prepare- ` is selectable but unreadable) and the heredoc terminator below
  // derives from the window name, so unsanitized chars can break script staging.
  const rawLabel = (opts?.windowLabel ?? '').trim();
  const labelPart = /^[A-Za-z0-9_-]+$/.test(rawLabel) ? rawLabel : Date.now().toString();
  const windowName = buildPrepareWindowName(labelPart);
  const target = `${sessionName}:${windowName}`;
  // Sentinel + remote log live on the host where tmux runs: the slot host by
  // default, or the orchestrator when forceLocal is set for orchestrator-only
  // scripts. Critical for remote slots: tmux pipe-pane writes on that host, so
  // the target path must exist there.
  const slotHostScratchDir = '/tmp/farmslot-prepare';
  const phasePart = opts?.phase ? `-${sanitizePhaseName(opts.phase)}` : '';
  const sentinelPath = `${slotHostScratchDir}/${sessionName}-${windowName}${phasePart}.exit`;
  const slotHostLogPath = `${slotHostScratchDir}/${sessionName}-${windowName}${phasePart}.log`;
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
    keepAliveOnSuccess: opts?.phase === 'preflight',
  });
  // Stage the wrapped command in a temp script so tmux respawn-pane can exec
  // bash directly against the file. Necessary because tmux runs respawn-pane's
  // shell-command through `default-shell` (often /bin/zsh on macOS), and zsh's
  // parser chokes on the bash subshell syntax `(...)` we use for sentinel
  // capture. Writing to a script keeps zsh out of the loop entirely.
  const wrappedScriptPath = `${slotHostScratchDir}/${sessionName}-${windowName}${phasePart}.sh`;
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
  // aborted run, orphaned cleanup). The prepare UX is intentionally one window per
  // flow invocation (`prepare-<runId8>`), not phase-split windows like
  // `prepare-<runId8>-deps` / `prepare-<runId8>-preflight`, so any stale prepare
  // window in this slot session is safe to remove before launching the current
  // command. activePrepareSlots prevents concurrent prepares for the same slot.
  await exec(
    tmuxShellSnippet(
      `list-windows -t ${shellQuote(sessionName)} -F '#{window_name}' 2>/dev/null | ` +
        `grep '^prepare-' | ` +
        `while IFS= read -r w; do "$TMUX_BIN" kill-window -t ${shellQuote(sessionName)}:"$w" 2>/dev/null; done`,
    ),
    { cwd: opts?.cwd, timeout: 15_000 },
  ).catch(() => undefined);
  // Pre-create the slot-host scratch dir + truncate any prior log so pipe-pane has a
  // clean target. We do this BEFORE launching the window so pipe-pane doesn't race the
  // mkdir inside the wrapped cmd. Also stage the wrapped script here so the respawn
  // call can exec it directly without going through a host-shell parser.
  const stageHeredocLimit = `__FARMSLOT_PREPARE_${windowName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}__`;
  const stageR = await exec(
    `mkdir -p ${shellQuote(slotHostScratchDir)} && rm -f ${shellQuote(sentinelPath)} && : > ${shellQuote(slotHostLogPath)} && cat > ${shellQuote(wrappedScriptPath)} <<'${stageHeredocLimit}'\n${wrappedCmd}\n${stageHeredocLimit}\n`,
    { cwd: opts?.cwd, timeout: 10_000 },
  );
  if (stageR.exitCode !== 0) {
    return failSetup('stage prepare script', stageR);
  }
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
  if (remainR.exitCode !== 0) {
    await exec(tmuxShellSnippet(`kill-window -t ${shellQuote(target)} 2>/dev/null || true`), {
      timeout: 10_000,
    });
    return failSetup('tmux remain-on-exit', remainR);
  }
  const pipeR = await exec(pipeCmd, { cwd: opts?.cwd, timeout: 10_000 });
  if (pipeR.exitCode !== 0) {
    await exec(tmuxShellSnippet(`kill-window -t ${shellQuote(target)} 2>/dev/null || true`), {
      timeout: 10_000,
    });
    return failSetup('tmux pipe-pane', pipeR);
  }
  // Now that pipe-pane is attached, respawn the pane with the real wrapped
  // command. The dormant placeholder loop is killed by `-k`; pipe-pane
  // subscription survives since it's bound to the pane, not the process.
  const respawnR = await exec(respawnCmd, { cwd: opts?.cwd, timeout: 15_000 });
  if (respawnR.exitCode !== 0) {
    await exec(tmuxShellSnippet(`kill-window -t ${shellQuote(target)} 2>/dev/null || true`), {
      timeout: 10_000,
    });
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
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();

  const killWindow = () =>
    exec(tmuxShellSnippet(`kill-window -t ${shellQuote(target)} 2>/dev/null || true`), {
      timeout: 10_000,
    });

  // Poll for the sentinel file (cmd exit code). Honour timeout + abort signal.
  const startTime = Date.now();
  const pollInterval = 1500;
  let exitCode: number | null = null;
  while (true) {
    if (opts?.signal?.aborted) {
      await killWindow();
      tailAborted = true;
      await tailPromise.catch(() => undefined);
      return { stdout: '', stderr: 'aborted', exitCode: 130 };
    }
    if (opts?.timeout && Date.now() - startTime > opts.timeout) {
      await killWindow();
      tailAborted = true;
      await tailPromise.catch(() => undefined);
      return { stdout: '', stderr: `timed out after ${opts.timeout}ms`, exitCode: 124 };
    }
    const checkR = await pollExec(
      'sentinel',
      `test -f ${shellQuote(sentinelPath)} && cat ${shellQuote(sentinelPath)}`,
      PREPARE_SENTINEL_POLL_TIMEOUT_MS,
    );
    if (checkR && checkR.exitCode === 0 && checkR.stdout.trim()) {
      const parsed = Number.parseInt(checkR.stdout.trim(), 10);
      exitCode = Number.isFinite(parsed) ? parsed : 1;
      break;
    }
    // If the prepare window died without writing a sentinel, treat as failure rather than spin.
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
      exitCode = 1;
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
    await exec(`rm -f ${shellQuote(sentinelPath)} ${shellQuote(slotHostLogPath)}`, {
      timeout: 5_000,
    }).catch(() => undefined);
  } else {
    // Always kill failed/aborted/timeout prepare windows. On failure we keep the
    // slot-host log + sentinel on disk for later inspection.
    await killWindow();
    await appendFile(
      logPath,
      `\n[tmux] cmd exit=${exitCode}; prepare window cleaned up.\n` +
        `      Slot-host scrollback log: ${slotHostLogPath}\n` +
        `      Sentinel: ${sentinelPath}\n`,
    );
  }

  return { stdout: '', stderr: '', exitCode: exitCode ?? 1 };
}
