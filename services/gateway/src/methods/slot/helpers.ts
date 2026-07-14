// methods/slot/helpers.ts — operator slot helper verbs.
//
// TypeScript ports of five retired bash scripts:
//   monitor-slot.sh       → slotMonitor      (worker-progress report)
//   show-slot.sh          → slotShow         (emulator headless → visible toggle)
//   soft-refresh-slot.sh  → slotSoftRefresh  (reload extension page via CDP)
//   reopen-slot-browser.sh→ slotReopen       (reopen the prepared browser)
//   auto-refresh-slot.sh  → slotAutoRefresh  (start/stop the auto-refresh tmux monitor)
//
// Decision logic (slot resolution, arg/path validation, command composition) lives
// here in TS; the ssh/tmux/CDP side-effects run through the shared exec plumbing
// (`execOnSlot` local/remote, `execLocal` orchestrator-local).

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import type {
  SlotAutoRefreshParams,
  SlotAutoRefreshResult,
  SlotCommandResult,
  SlotMonitorParams,
  SlotMonitorResult,
  SlotReopenParams,
  SlotShowParams,
  SlotSoftRefreshParams,
} from '@farmslot/protocol';
import { runSessionUsage } from '@farmslot/slot-config';

import {
  execLocal,
  execOnSlot,
  farmslotRoot,
  GatewayMethodError,
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
  slotFileExists,
  type SlotVars,
} from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { runnerProcessPatternSource } from '../../runners/registry.js';

import type { EventEmitter } from './shared.js';

// Harness injection root — mirrors soft-refresh-slot.sh (path.sh default).
// Configurable via RECIPE_HARNESS_ROOT, not hardcoded.
const DEFAULT_HARNESS_ROOT = 'temp/recipe/harness';

// ─── Shared streaming helper ───
// Emits script.output / script.complete frames keyed to a requestId, matching
// the slot.refresh / slot.release contract the UI + CLI already consume.
function makeStream(emit: EventEmitter, requestId: string, startTime: number) {
  const line = (stream: 'stdout' | 'stderr', data: string) =>
    emit('script.output', {
      requestId,
      stream,
      data: data.endsWith('\n') ? data : `${data}\n`,
      timestamp: Date.now(),
    });
  return {
    onOutput: (stream: string, data: string) =>
      line(stream === 'stderr' ? 'stderr' : 'stdout', data),
    complete: (exitCode: number, error?: string) =>
      emit('script.complete', {
        requestId,
        exitCode,
        duration: Date.now() - startTime,
        ...(error ? { error } : {}),
      }),
  };
}

// ─── monitor ───

/** Compose the read-only worker-progress command (TASK status + branch + tmux
 * agent state + last 30 pane lines). Token usage is appended separately from the
 * TS session-usage port. `processPattern` is the runner-registry pgrep source so
 * agent-liveness detection follows the runner abstraction (no inline runner ids). */
export function buildMonitorCommand(
  vars: SlotVars,
  taskDirName: string,
  processPattern: string,
): string {
  const repo = shellQuote(vars.remoteRepo);
  const taskRoot = shellQuote(`${vars.remoteRepo}/${taskDirName}`);
  const session = shellQuote(vars.session);
  return [
    'set -uo pipefail',
    `echo "=== Monitor: ${vars.slotId} on ${vars.machine} (${vars.platform}) ==="`,
    'echo ""',
    'echo "TASK status"',
    `TASK_HEAD=$(find ${taskRoot} -name TASK.md -type f 2>/dev/null | head -1 | xargs head -20 2>/dev/null || true)`,
    'if [ -z "$TASK_HEAD" ]; then',
    '  echo "  No TASK.md found — slot may be idle"',
    'else',
    `  STATUS_LINE=$(echo "$TASK_HEAD" | grep -i 'status\\|phase' | head -3 || true)`,
    '  if [ -n "$STATUS_LINE" ]; then echo "$STATUS_LINE"; else echo "  (no status line found in TASK.md header)"; fi',
    'fi',
    'echo ""',
    'echo "Branch"',
    `BRANCH=$(git -C ${repo} rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')`,
    'echo "  $BRANCH"',
    'echo ""',
    'echo "Agent"',
    `if tmux has-session -t ${session} 2>/dev/null; then`,
    `  PANE_PID=$(tmux list-panes -t ${session} -F '#{pane_pid}' 2>/dev/null | head -1 || true)`,
    '  if [ -n "$PANE_PID" ]; then',
    `    if pgrep -P "$PANE_PID" -f '${processPattern}' >/dev/null 2>&1; then`,
    '      echo "  Agent is running"',
    '    else',
    '      echo "  Agent idle (no runner process)"',
    '    fi',
    '  fi',
    '  echo ""',
    '  echo "Output (last 30 lines)"',
    `  tmux capture-pane -p -J -t ${session} -S -30 2>/dev/null || echo "  Could not capture pane"`,
    'else',
    `  echo "  tmux session ${vars.session} not found"`,
    'fi',
  ].join('\n');
}

export async function slotMonitor(params: SlotMonitorParams): Promise<SlotMonitorResult> {
  const vars = await loadSlotVars(params.slotId);
  let taskDirName = '.task';
  try {
    const pv = await loadProjectVars(vars.projectName);
    taskDirName = resolveProjectTaskDirName(pv.projectJson);
  } catch (err) {
    // A genuinely-absent project config is expected for idle/unassigned slots →
    // fall back to the protocol default task dir. A malformed or unreadable
    // config is a real error and must surface (no-swallowed-exceptions rule).
    if (!(err instanceof Error) || !err.message.startsWith('Project config not found')) {
      throw err;
    }
  }

  const main = await execOnSlot(
    vars,
    buildMonitorCommand(vars, taskDirName, runnerProcessPatternSource()),
    { timeout: 20_000 },
  );

  const report = `${main.stdout.trimEnd()}\n\nToken usage\n${await readMonitorUsage(vars)}\n`;
  return { report };
}

/** Token usage via the TS session-usage port (not the retired session-usage.sh).
 * Mirrors monitor-slot.sh's `report || total` fallback: the diff-since-snapshot
 * `report` when a snapshot exists, else the running `total`. Usage being
 * unavailable (idle slot, no transcript) is expected and reported inline. */
async function readMonitorUsage(vars: SlotVars): Promise<string> {
  for (const action of ['report', 'total'] as const) {
    try {
      const output = (
        await runSessionUsage({ repo: vars.remoteRepo, slotId: vars.slotId, action })
      ).trim();
      if (output) return output;
    } catch {
      // `report` throws when no snapshot exists yet — fall through to `total`;
      // `total` throws when the slot has no discoverable transcript at all.
    }
  }
  return 'No usage data available';
}

// ─── show ───

/** Emulator headless → visible toggle (Android/Linux-runner). Kills the headless
 * emulator, ensures an X display, relaunches windowed (detached so exec returns),
 * waits for boot, and prints remote-view instructions. */
export function buildShowScript(avd: string, adbSerial: string, machine: string): string {
  const avdQ = shellQuote(avd);
  const serialQ = shellQuote(adbSerial);
  return [
    // -e is load-bearing: a failed adb/Xvfb/emulator-launch must abort rather than
    // fall through to the "Emulator visible" echoes and exit 0 on a dead emulator.
    'set -euo pipefail',
    `echo "=== show-slot: ${avd} (${adbSerial}) ==="`,
    `EMULATOR_PID=$(ps aux | grep "emulator.*-avd ${avd}" | grep -v grep | awk '{print $2}' || true)`,
    'if [ -n "$EMULATOR_PID" ]; then',
    '  echo "Killing headless emulator (PID $EMULATOR_PID)..."',
    '  kill "$EMULATOR_PID" 2>/dev/null || true',
    '  sleep 3',
    'else',
    `  echo "No running emulator found for ${avd}"`,
    'fi',
    'DISPLAY_NUM=99',
    'if [ -z "${DISPLAY:-}" ]; then',
    '  echo "No DISPLAY set — starting Xvfb on :$DISPLAY_NUM"',
    '  if ! pgrep -f "Xvfb :$DISPLAY_NUM" >/dev/null 2>&1; then',
    '    command -v Xvfb >/dev/null || { echo "Installing Xvfb..."; sudo apt-get update -qq && sudo apt-get install -y -qq xvfb; }',
    '    Xvfb ":$DISPLAY_NUM" -screen 0 1280x720x24 >/dev/null 2>&1 &',
    '    sleep 1',
    '    echo "[OK] Xvfb started on :$DISPLAY_NUM"',
    '  else',
    '    echo "[OK] Xvfb already running on :$DISPLAY_NUM"',
    '  fi',
    '  export DISPLAY=":$DISPLAY_NUM"',
    'fi',
    'echo "Launching ' + avd + ' with window on DISPLAY=$DISPLAY..."',
    // Detach the windowed emulator so it survives this exec (the bash -c wrapper
    // exits once boot completes); without nohup+disown the pipe would stay open.
    `nohup emulator -avd ${avdQ} -no-audio -no-boot-anim -gpu swiftshader_indirect >/dev/null 2>&1 &`,
    'NEW_PID=$!',
    'disown "$NEW_PID" 2>/dev/null || true',
    'echo "Emulator PID: $NEW_PID"',
    `adb -s ${serialQ} wait-for-device 2>/dev/null`,
    `adb -s ${serialQ} shell 'while [ -z "$(getprop sys.boot_completed)" ]; do sleep 1; done' 2>/dev/null`,
    'echo ""',
    'echo "========================================="',
    `echo "Emulator ${avd} visible on DISPLAY=$DISPLAY"`,
    'echo ""',
    'echo "To view remotely:"',
    'echo ""',
    'echo "  Option 1 — SSH X forwarding:"',
    `echo "    ssh -X user@${machine}"`,
    'echo "    DISPLAY=:$DISPLAY_NUM scrot /tmp/screen.png  # screenshot"',
    'echo ""',
    'echo "  Option 2 — VNC (install x11vnc):"',
    'echo "    x11vnc -display :$DISPLAY_NUM -nopw -forever &"',
    `echo "    # Then connect VNC client to ${machine}:5900"`,
    'echo ""',
    'echo "  Option 3 — adb screenshot (no X needed):"',
    `echo "    adb -s ${adbSerial} exec-out screencap -p > /tmp/screen.png"`,
    'echo ""',
    'echo "To return to headless:"',
    `echo "    kill $NEW_PID"`,
    'echo "========================================="',
  ].join('\n');
}

export async function slotShow(
  params: SlotShowParams,
  emit: EventEmitter,
): Promise<SlotCommandResult> {
  const vars = await loadSlotVars(params.slotId);
  const avd = vars.resourceVars.avd;
  const adbSerial = vars.resourceVars.adb_serial;
  if (!avd || !adbSerial) {
    throw new GatewayMethodError(
      'SLOT_SHOW_UNSUPPORTED',
      `slot show requires an emulator slot (avd + adb_serial resources); ${params.slotId} has none`,
      { userAction: `farmslot slot check ${params.slotId}` },
    );
  }
  const requestId = params.requestId ?? `show-${randomUUID()}`;
  const startTime = Date.now();
  const stream = makeStream(emit, requestId, startTime);
  const result = await execOnSlot(vars, buildShowScript(avd, adbSerial, vars.machine), {
    onOutput: stream.onOutput,
    timeout: 300_000,
  });
  stream.complete(result.exitCode);
  return { ...result, requestId };
}

// ─── soft-refresh ───

/** Validate a RECIPE_HARNESS_ROOT: relative, safe charset, no '.'/'..' components —
 * so a hostile value can't escape the repo. Mirrors soft-refresh-slot.sh. */
export function validateHarnessRoot(harnessRoot: string): void {
  if (harnessRoot === '' || harnessRoot.startsWith('/') || /[^A-Za-z0-9._/-]/.test(harnessRoot)) {
    throw new Error(`invalid RECIPE_HARNESS_ROOT: '${harnessRoot}'`);
  }
  if (`/${harnessRoot}/`.includes('/../') || `/${harnessRoot}/`.includes('/./')) {
    throw new Error(`RECIPE_HARNESS_ROOT must not contain '.'/'..' components`);
  }
}

export function buildSoftRefreshCommand(
  recipesDir: string,
  cdpPort: string,
  slotId: string,
): string {
  return `cd ${shellQuote(recipesDir)} && node soft-refresh.js --cdp-port ${shellQuote(cdpPort)} --slot-id ${shellQuote(slotId)}`;
}

/** Clean no-op result for a disabled slot — the retired helper scripts exited 0
 * after `check_slot_enabled`, never mutating CDP/browser/tmux state. */
function disabledSlotNoop(
  verb: string,
  slotId: string,
  requestId: string | undefined,
): SlotCommandResult {
  return {
    stdout: `Slot ${slotId} is disabled — ${verb} skipped\n`,
    stderr: '',
    exitCode: 0,
    requestId: requestId ?? `${verb}-${randomUUID()}`,
  };
}

export async function slotSoftRefresh(
  params: SlotSoftRefreshParams,
  emit: EventEmitter,
): Promise<SlotCommandResult> {
  const vars = await loadSlotVars(params.slotId);
  if (!vars.slotEnabled) return disabledSlotNoop('soft-refresh', params.slotId, params.requestId);
  const cdpPort = vars.resourceVars.cdp_port;
  if (!cdpPort) {
    throw new GatewayMethodError(
      'SLOT_SOFT_REFRESH_UNSUPPORTED',
      `slot soft-refresh requires a cdp_port resource; ${params.slotId} has none`,
      { userAction: `farmslot slot check ${params.slotId}` },
    );
  }
  const harnessRoot = process.env.RECIPE_HARNESS_ROOT || DEFAULT_HARNESS_ROOT;
  validateHarnessRoot(harnessRoot);
  const recipesDir = `${vars.remoteRepo}/${harnessRoot}/extension/runner/recipes`;
  if (!(await slotFileExists(vars, `${recipesDir}/soft-refresh.js`))) {
    throw new GatewayMethodError(
      'SLOT_FIXTURES_MISSING',
      `soft-refresh.js not found at ${recipesDir}/soft-refresh.js`,
      { userAction: `farmslot slot fixtures ${params.slotId}` },
    );
  }
  const requestId = params.requestId ?? `soft-refresh-${randomUUID()}`;
  const startTime = Date.now();
  const stream = makeStream(emit, requestId, startTime);
  const result = await execOnSlot(
    vars,
    buildSoftRefreshCommand(recipesDir, cdpPort, params.slotId),
    {
      onOutput: stream.onOutput,
      timeout: 120_000,
    },
  );
  stream.complete(result.exitCode);
  return { ...result, requestId };
}

// ─── reopen ───

export function buildReopenCommand(opts: {
  reopenScript: string;
  slotId: string;
  repo: string;
  runtimeDir: string;
  cdpPort?: string;
  watcherPort?: string;
}): string {
  const parts = [
    `bash ${shellQuote(opts.reopenScript)}`,
    `--slot-id ${shellQuote(opts.slotId)}`,
    `--repo ${shellQuote(opts.repo)}`,
  ];
  if (opts.cdpPort) parts.push(`--cdp-port ${shellQuote(opts.cdpPort)}`);
  parts.push(`--runtime-dir ${shellQuote(opts.runtimeDir)}`);
  if (opts.watcherPort) parts.push(`--watcher-port ${shellQuote(opts.watcherPort)}`);
  return parts.join(' ');
}

export async function slotReopen(
  params: SlotReopenParams,
  emit: EventEmitter,
): Promise<SlotCommandResult> {
  const vars = await loadSlotVars(params.slotId);
  if (!vars.slotEnabled) return disabledSlotNoop('reopen', params.slotId, params.requestId);
  // reopen-slot-browser.sh failed hard on a missing project config; keep that
  // contract — let loadProjectVars throw rather than silently defaulting.
  const projectVars = await loadProjectVars(vars.projectName);
  // Overrides mirror the retired reopen-slot-browser.sh flags (--repo,
  // --runtime-dir, --cdp-port, --watcher-port), each taking priority over the
  // slot/project-derived default.
  const repo = params.repo ?? vars.remoteRepo;
  const runtimeDir = params.runtimeDir ?? projectVars.runtimeDir;
  const reopenScript = `${repo}/${runtimeDir}/reopen-browser.sh`;
  if (!(await slotFileExists(vars, reopenScript))) {
    throw new GatewayMethodError(
      'SLOT_FIXTURES_MISSING',
      `reopen script not found at ${reopenScript}`,
      { userAction: `farmslot slot fixtures ${params.slotId}` },
    );
  }
  const requestId = params.requestId ?? `reopen-${randomUUID()}`;
  const startTime = Date.now();
  const stream = makeStream(emit, requestId, startTime);
  const command = buildReopenCommand({
    reopenScript,
    slotId: params.slotId,
    repo,
    runtimeDir,
    cdpPort: params.cdpPort ?? vars.resourceVars.cdp_port,
    watcherPort: params.watcherPort ?? vars.resourceVars.watcher_port ?? vars.resourceVars.port,
  });
  const result = await execOnSlot(vars, command, { onOutput: stream.onOutput, timeout: 120_000 });
  stream.complete(result.exitCode);
  return { ...result, requestId };
}

// ─── auto-refresh ───

// tmux session name for a slot's auto-refresh monitor (matches auto-refresh-slot.sh).
export function autoRefreshSessionName(slotId: string): string {
  return `autorefresh-${slotId.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

export function buildAutoRefreshCommand(opts: {
  action: 'start' | 'stop';
  session: string;
  projectDir: string;
  scriptPath: string;
  slotId: string;
  repo: string;
  cdpPort?: string;
}): string {
  const kill = `tmux kill-session -t ${shellQuote(opts.session)} 2>/dev/null || true`;
  if (opts.action === 'stop') return kill;
  const inner = [
    `cd ${shellQuote(opts.projectDir)}`,
    `exec bash ${shellQuote(opts.scriptPath)} --slot-id ${shellQuote(opts.slotId)} --repo ${shellQuote(opts.repo)}` +
      (opts.cdpPort ? ` --cdp-port ${shellQuote(opts.cdpPort)}` : ''),
  ].join(' && ');
  return `${kill}; tmux new-session -d -s ${shellQuote(opts.session)} ${shellQuote(inner)}`;
}

export async function slotAutoRefresh(
  params: SlotAutoRefreshParams,
): Promise<SlotAutoRefreshResult> {
  const vars = await loadSlotVars(params.slotId);
  const action: 'start' | 'stop' = params.action ?? 'start';
  if (!vars.slotEnabled) {
    // Disabled slots never ran the monitor; mirror check_slot_enabled's clean exit.
    return { action, session: autoRefreshSessionName(params.slotId) };
  }
  const session = autoRefreshSessionName(params.slotId);
  const pv = await loadProjectVars(vars.projectName);
  const scriptPath = `${farmslotRoot}/projects/${pv.projectName}/setup/auto-refresh.sh`;

  // The monitor tmux session and this probe both run on the orchestrator via
  // execLocal (the original script never wrapped tmux in run_on so it can reach
  // the slot's CDP), so the script must be checked on the local filesystem — a
  // remote node-RPC probe would always miss the orchestrator-local project dir.
  if (action === 'start' && !existsSync(scriptPath)) {
    throw new GatewayMethodError(
      'SLOT_AUTO_REFRESH_NO_SCRIPT',
      `auto refresh script not found for project ${pv.projectName}: ${scriptPath}`,
    );
  }

  const command = buildAutoRefreshCommand({
    action,
    session,
    projectDir: farmslotRoot,
    scriptPath,
    slotId: params.slotId,
    repo: vars.remoteRepo,
    cdpPort: vars.resourceVars.cdp_port,
  });
  const result = await execLocal(command, { cwd: farmslotRoot, timeout: 20_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `auto-refresh ${action} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return { action, session };
}
