import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_BRANCH, type SlotCheckParams, type SlotCheckResult } from '@farmslot/protocol';

import {
  execOnSlot,
  expandHook,
  expandPlatformField,
  expandTemplate,
  getProjectField,
  isLocal,
  loadProjectVars,
  loadSlotVars,
  type ProjectVars,
  type RawProjectJson,
  renderFixtureTemplate,
  type SlotVars,
  withMachineEnv,
  withProjectMachineEnv,
} from '../../core/index.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../../core/tmux.js';
import { loadFleetStatus } from '../../fleet/state.js';
import {
  resolveClaudeBinary,
  resolveCodexBinary,
  wrapWorkerShellCommand,
} from '../../runners/launch-command.js';
import { normalizeRunner } from '../../runners/registry.js';

import { checkCommitSigning, loadGitIdentity } from './git-identity.js';
import { checkProjectPrerequisites } from './prerequisites.js';
import { applySelectedApp, type CheckStep, type EventEmitter } from './shared.js';
import { probeDefaultBranch } from './slot-tracking.js';

function emitStep(emit: EventEmitter, step: CheckStep): void {
  emit('slot.check.step', step);
}

// ─── slotCheck — native TS port of check-slot.sh ───

export async function slotCheck(
  params: SlotCheckParams,
  emit: EventEmitter,
): Promise<SlotCheckResult> {
  const slotVars = await loadSlotVars(params.slotId);
  await applySelectedApp(slotVars);

  let projectVars: ProjectVars | undefined;
  let projectJson: RawProjectJson = {};
  try {
    projectVars = await loadProjectVars(slotVars.projectName);
    projectJson = projectVars.projectJson;
  } catch {
    /* project config may not exist */
  }

  const devServerName = getProjectField(projectJson, 'health.dev_server_name') || 'DevServer';
  const readyIndicator = getProjectField(projectJson, 'health.ready_indicator');
  const devServerLog = getProjectField(projectJson, 'health.dev_server_log');
  const parseHealthCmd = getProjectField(projectJson, 'health.parse_health');

  const checks: CheckStep[] = [];
  let aborted = false;

  // Emit slot info
  emit('slot.check.info', {
    slotId: params.slotId,
    machine: slotVars.machine,
    platform: slotVars.platform,
    host: slotVars.sshTarget,
    repo: slotVars.remoteRepo,
    project: slotVars.projectName,
    session: slotVars.session,
    port: slotVars.resourceVars.port ?? '',
  });

  // ── 1. SSH / connectivity ──
  const sshStep = await checkSSH(slotVars);
  checks.push(sshStep);
  emitStep(emit, sshStep);
  if (sshStep.status === 'fail') {
    aborted = true;
  }

  if (!aborted) {
    // ── 2. Repo exists ──
    const repoStep = await checkRepo(slotVars);
    checks.push(repoStep);
    emitStep(emit, repoStep);
    if (repoStep.status === 'pass') {
      let prerequisites: CheckStep | null;
      try {
        prerequisites = await checkProjectPrerequisites(slotVars, projectJson, projectVars);
      } catch (err) {
        prerequisites = { name: 'prerequisites', status: 'fail', detail: (err as Error).message };
      }
      if (prerequisites) {
        checks.push(prerequisites);
        emitStep(emit, prerequisites);
      }
      const branchStep = await checkDefaultBranch(
        slotVars,
        getProjectField(projectJson, 'default_branch') || DEFAULT_BRANCH,
      );
      checks.push(branchStep);
      emitStep(emit, branchStep);
      let signingStep: CheckStep;
      try {
        signingStep = await checkCommitSigning(slotVars, loadGitIdentity());
      } catch (err) {
        signingStep = { name: 'git.signing', status: 'fail', detail: (err as Error).message };
      }
      checks.push(signingStep);
      emitStep(emit, signingStep);
      // Streams each probe as it completes; pushed here without re-emitting.
      checks.push(
        ...(await checkRunnerLaunch(slotVars, projectJson, projectVars, {
          onProgress: (step) => emitStep(emit, step),
        })),
      );
    }

    // ── 3. Fixtures ──
    const fixtureSteps = await checkFixtures(slotVars, projectVars, projectJson);
    for (const step of fixtureSteps) {
      checks.push(step);
      emitStep(emit, step);
    }

    // ── 4. Device ──
    const deviceStep = await checkDevice(slotVars, projectJson, projectVars);
    checks.push(deviceStep);
    emitStep(emit, deviceStep);

    // ── 5. Dev server ──
    const devSteps = await checkDevServer(
      slotVars,
      projectJson,
      projectVars,
      devServerName,
      devServerLog,
    );
    for (const step of devSteps) {
      checks.push(step);
      emitStep(emit, step);
    }

    // ── 6. Health / CDP ──
    const healthStep = await checkHealth(
      slotVars,
      projectJson,
      projectVars,
      readyIndicator,
      parseHealthCmd,
      { onProgress: (step) => emitStep(emit, step) },
    );
    if (healthStep) {
      checks.push(healthStep);
      emitStep(emit, healthStep);
    }

    // ── 7. Cleanup stale files ──
    const cleanStep = await checkCleanup(slotVars);
    checks.push(cleanStep);
    emitStep(emit, cleanStep);

    // ── 8. tmux session ──
    const tmuxStep = await checkTmux(slotVars);
    checks.push(tmuxStep);
    emitStep(emit, tmuxStep);
  }

  // Build slot status from fleet (for the return)
  const fleet = await loadFleetStatus();
  const slotStatus = fleet.slots.find((s) => s.slot === params.slotId);

  const failures = checks.filter((c) => c.status === 'fail');
  const warnings = checks.filter((c) => c.status === 'warn');
  const ready = failures.length === 0 && warnings.length === 0;

  emit('slot.check.done', {
    slotId: params.slotId,
    ready,
    failures: failures.length,
    warnings: warnings.length,
  });

  return {
    slot: slotStatus ?? {
      slot: params.slotId,
      machine: slotVars.machine,
      platform: slotVars.platform,
      project: slotVars.projectName,
      health: { ssh: '-', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
      branch: '-',
      agent: 'idle',
      enabled: slotVars.slotEnabled,
      dispatchable: false,
      lifecycle: slotVars.slotMode === 'disabled' ? 'disabled' : 'ready',
      phase: null,
      warm: false,
      taskId: null,
      taskFile: null,
      dispatchedAt: null,
      completedAt: null,
      runner: null,
      model: null,
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    },
    checks: checks.map((c) => {
      const status = c.status === 'warn' ? 'fail' : c.status === 'skip' ? 'pass' : c.status;
      return { name: c.name, status, detail: c.detail };
    }),
  };
}

// ─── Individual check functions ───

async function checkSSH(vars: SlotVars): Promise<CheckStep> {
  if (isLocal(vars.host, vars.machine)) {
    return { name: 'ssh', status: 'pass', detail: `LOCAL (${vars.machine})` };
  }
  try {
    const result = await execOnSlot(vars, 'echo ok');
    if (result.exitCode === 0 && result.stdout.trim() === 'ok') {
      return { name: 'ssh', status: 'pass', detail: `SSH to ${vars.sshTarget}` };
    }
    return { name: 'ssh', status: 'fail', detail: `Cannot SSH to ${vars.sshTarget}` };
  } catch (err) {
    return {
      name: 'ssh',
      status: 'fail',
      detail: `Cannot SSH to ${vars.sshTarget}: ${(err as Error).message}`,
    };
  }
}

async function checkRepo(vars: SlotVars): Promise<CheckStep> {
  try {
    // Linked clones use a .git directory; git worktrees use a .git file.
    const result = await execOnSlot(vars, `test -e ${shellQuote(`${vars.remoteRepo}/.git`)}`);
    if (result.exitCode === 0) {
      return { name: 'repo', status: 'pass', detail: `Repo exists at ${vars.remoteRepo}` };
    }
    return { name: 'repo', status: 'fail', detail: `Repo not found at ${vars.remoteRepo}` };
  } catch {
    return { name: 'repo', status: 'fail', detail: `Repo not found at ${vars.remoteRepo}` };
  }
}

export async function checkDefaultBranch(
  vars: SlotVars,
  defaultBranch: string,
): Promise<CheckStep> {
  const name = 'repo.default-branch';
  const probe = await probeDefaultBranch(vars, defaultBranch);
  if (!probe.readable) {
    return {
      name,
      status: 'warn',
      detail: `No verdict: git could not read the repo (${probe.error})`,
    };
  }
  if (probe.blocker) return { name, status: 'fail', detail: probe.blocker };
  return { name, status: 'pass', detail: `Default branch ${defaultBranch} is fetched` };
}

/**
 * Runner binaries a dispatch on this slot can launch: claude (the dispatch
 * fallback) and codex when the pool gives it a path or a project flow
 * defaults to it.
 */
export function slotRunnerBinaries(
  vars: SlotVars,
  projectJson: RawProjectJson,
): { runner: string; binary: string }[] {
  const runners = [{ runner: 'claude', binary: resolveClaudeBinary(vars.claudePath) }];
  const defaults = Object.values(projectJson.defaults ?? {}).map((d) => normalizeRunner(d.runner));
  if (vars.codexPath || defaults.includes('codex')) {
    runners.push({ runner: 'codex', binary: resolveCodexBinary(vars.codexPath) });
  }
  return runners;
}

const PINNED_VERSION_MISSING_RE = /No preinstalled version|is not installed|No version is set/i;
const TOOL_VERSIONS_PIN = '.tool-versions pins ';

/**
 * Resolve node and the runner binaries in the slot repo with the env a worker
 * launch gets (project command_env, worker PATH prefix, machine env, repo cwd),
 * so a version manager pin the host cannot satisfy (asdf `.tool-versions`)
 * fails here instead of at dispatch. Probes run in parallel; each result and a
 * heartbeat while any is pending go to `onProgress`, so streaming clients see
 * activity when a remote node is slow to answer.
 */
export async function checkRunnerLaunch(
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars?: ProjectVars,
  progress: HealthProgressOptions = {},
): Promise<CheckStep[]> {
  const onProgress = progress.onProgress ?? (() => {});
  const inWorkerShell = (command: string) =>
    wrapWorkerShellCommand(withMachineEnv(command, vars), { projectJson, vars, projectVars });
  // A bad project command_env fails every probe the same way: report it once.
  try {
    inWorkerShell('true');
  } catch (err) {
    const step: CheckStep = {
      name: 'runner',
      status: 'fail',
      detail: `Worker env cannot be built: ${(err as Error).message}`,
    };
    onProgress(step);
    return [step];
  }

  const probes = [
    { name: 'runner.node', binary: 'node' },
    ...slotRunnerBinaries(vars, projectJson).map(({ runner, binary }) => ({
      name: `runner.${runner}`,
      binary,
    })),
  ];
  const pending = new Set(probes.map((probe) => probe.name));
  return withHeartbeat(
    progress,
    'runner',
    () => `Still probing ${[...pending].join(', ')}`,
    () =>
      Promise.all(
        probes.map(async ({ name, binary }) => {
          const step = await probeBinary(vars, name, binary, inWorkerShell);
          pending.delete(name);
          onProgress(step);
          return step;
        }),
      ),
  );
}

async function probeBinary(
  vars: SlotVars,
  name: string,
  binary: string,
  inWorkerShell: (command: string) => string,
): Promise<CheckStep> {
  let result: Awaited<ReturnType<typeof execOnSlot>>;
  try {
    // On failure, name the Node version the repo pins: asdf's own message does not.
    const command = `cd ${shellQuote(vars.remoteRepo)} && { ${binary} --version 2>&1 || { rc=$?; sed -n 's/^nodejs[[:space:]][[:space:]]*/${TOOL_VERSIONS_PIN}nodejs /p' .tool-versions 2>/dev/null; exit $rc; }; }`;
    result = await execOnSlot(vars, inWorkerShell(command), { timeout: 30_000 });
  } catch (err) {
    return { name, status: 'fail', detail: `${binary} check failed: ${(err as Error).message}` };
  }
  const lines = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const output = lines.filter((line) => !line.startsWith(TOOL_VERSIONS_PIN));
  if (result.exitCode === 0) {
    return { name, status: 'pass', detail: `${binary} ${output[0] ?? ''}`.trim() };
  }
  // The pin explains only a version-manager refusal, not an unrelated failure.
  const pinMissing = PINNED_VERSION_MISSING_RE.test(output.join('\n'));
  const pin = pinMissing ? lines.find((line) => line.startsWith(TOOL_VERSIONS_PIN)) : undefined;
  const pinned = pin
    ? ` ${pin.slice(TOOL_VERSIONS_PIN.length)}`
    : ' the toolchain version the repo pins';
  const fix = pinMissing
    ? `install${pinned} on ${vars.machine} (e.g. \`asdf install\` in ${vars.remoteRepo})`
    : result.exitCode === 127
      ? binary === 'node'
        ? `install node on ${vars.machine} or add its directory to the pool \`env.PATH\``
        : `install ${binary} on ${vars.machine} or set its path in the pool config`
      : `run \`${binary} --version\` in ${vars.remoteRepo} on ${vars.machine}`;
  // The cause leads: asdf follows it with every installed version.
  const head = output.slice(0, 2).join(' | ');
  return {
    name,
    status: 'fail',
    detail: `${binary} cannot start in ${vars.remoteRepo} (exit ${result.exitCode})${head ? `: ${head}` : ''}${pin ? `; ${pin}` : ''}. Fix: ${fix}`,
  };
}

/**
 * A missing fixture src is not a problem when the entry is marked optional or
 * its path still carries unresolved placeholders (e.g. a dispatch-scoped
 * `{{domain}}` the slot cannot expand) — those entries only materialize for
 * deployments that provide them.
 */
export function isOptionalFixtureAbsence(
  tpl: { src?: string; optional?: boolean },
  expandedSrc: string,
): boolean {
  if (tpl.optional) return true;
  return /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(expandedSrc);
}

async function checkFixtures(
  vars: SlotVars,
  projectVars: ProjectVars | undefined,
  projectJson: RawProjectJson,
): Promise<CheckStep[]> {
  const steps: CheckStep[] = [];
  if (!projectVars || !projectJson.fixtures) {
    steps.push({ name: 'fixtures', status: 'skip', detail: 'No fixtures configured' });
    return steps;
  }

  const templates = projectJson.fixtures.templates ?? [];
  let mismatches = 0;

  // Check templates (skip compose entries without src)
  for (const tpl of templates) {
    const dst = expandTemplate(tpl.dst, vars, projectVars);
    if (!tpl.src) continue;
    const src = expandTemplate(tpl.src, vars, projectVars);
    const localPath = path.join(projectVars.projectFixturesDir, src);
    if (!existsSync(localPath)) {
      if (isOptionalFixtureAbsence(tpl, src)) {
        steps.push({
          name: `fixture:${dst}`,
          status: 'skip',
          detail: `Optional fixture ${src} not present locally`,
        });
        continue;
      }
      steps.push({
        name: `fixture:${dst}`,
        status: 'warn',
        detail: `Template ${src} not found locally`,
      });
      mismatches++;
      continue;
    }
    const rendered = await renderFixtureTemplate(localPath, vars, projectVars);
    const localMd5 = md5(rendered);
    const remoteMd5 = await getRemoteMd5(vars, `${vars.remoteRepo}/${dst}`);
    if (!remoteMd5) {
      steps.push({
        name: `fixture:${dst}`,
        status: 'warn',
        detail: `${dst} missing on worker`,
      });
      mismatches++;
    } else if (localMd5 === remoteMd5) {
      steps.push({
        name: `fixture:${dst}`,
        status: 'pass',
        detail: `${dst} — ${localMd5.slice(0, 8)}`,
      });
    } else {
      steps.push({
        name: `fixture:${dst}`,
        status: 'warn',
        detail: `${dst} mismatch (expected ${localMd5.slice(0, 8)}, got ${remoteMd5.slice(0, 8)})`,
      });
      mismatches++;
    }
  }

  // Check directories (sentinel-based)
  const directories = projectJson.fixtures.directories ?? [];
  for (const dir of directories) {
    const dst = expandTemplate(dir.dst, vars, projectVars);
    const remoteDirPath = `${vars.remoteRepo}/${dst}`;
    try {
      const dirExists = await execOnSlot(vars, `test -d ${shellQuote(remoteDirPath)}`);
      if (dirExists.exitCode !== 0) {
        steps.push({
          name: `fixture:${dst}/`,
          status: 'warn',
          detail: `${dst}/ missing on worker`,
        });
        mismatches++;
        continue;
      }
      if (dir.sentinel) {
        const localSentinel = path.join(projectVars.projectFixturesDir, dir.src, dir.sentinel);
        if (existsSync(localSentinel)) {
          const localContent = await readFile(localSentinel, 'utf-8');
          const localMd5 = md5(localContent);
          const remoteMd5 = await getRemoteMd5(vars, `${remoteDirPath}/${dir.sentinel}`);
          if (!remoteMd5) {
            steps.push({
              name: `fixture:${dst}/`,
              status: 'warn',
              detail: `${dst}/${dir.sentinel} missing on worker`,
            });
            mismatches++;
          } else if (localMd5 === remoteMd5) {
            steps.push({
              name: `fixture:${dst}/`,
              status: 'pass',
              detail: `${dst}/ — sentinel ${localMd5.slice(0, 8)}`,
            });
          } else {
            steps.push({
              name: `fixture:${dst}/`,
              status: 'warn',
              detail: `${dst}/ sentinel mismatch (${localMd5.slice(0, 8)} vs ${remoteMd5.slice(0, 8)})`,
            });
            mismatches++;
          }
        } else {
          steps.push({
            name: `fixture:${dst}/`,
            status: 'pass',
            detail: `${dst}/ exists (no local sentinel)`,
          });
        }
      } else {
        steps.push({ name: `fixture:${dst}/`, status: 'pass', detail: `${dst}/ exists` });
      }
    } catch {
      steps.push({
        name: `fixture:${dst}/`,
        status: 'warn',
        detail: `${dst}/ check failed`,
      });
      mismatches++;
    }
  }

  if (mismatches > 0) {
    steps.push({
      name: 'fixtures.summary',
      status: 'warn',
      detail: `${mismatches} fixture(s) out of sync`,
    });
  }

  return steps;
}

async function checkDevice(
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars?: ProjectVars,
): Promise<CheckStep> {
  const deviceCheck = expandPlatformField('device_check', projectJson, vars, projectVars);
  if (!deviceCheck) {
    return {
      name: 'device',
      status: 'skip',
      detail: `No device check configured for ${vars.platform}`,
    };
  }
  try {
    const result = await execOnSlot(vars, withMachineEnv(deviceCheck, vars));
    if (result.exitCode === 0) {
      const label =
        vars.platform === 'android'
          ? `Emulator ${vars.resourceVars.adb_serial ?? ''} running`
          : vars.platform === 'ios'
            ? `Simulator ${vars.resourceVars.simulator ?? ''} booted`
            : `Device check passed (${vars.platform})`;
      return { name: 'device', status: 'pass', detail: label };
    }
    const label =
      vars.platform === 'android'
        ? `Emulator ${vars.resourceVars.adb_serial ?? ''} not found`
        : vars.platform === 'ios'
          ? `Simulator ${vars.resourceVars.simulator ?? ''} not booted`
          : `Device check failed (${vars.platform})`;
    return { name: 'device', status: 'fail', detail: label };
  } catch {
    return { name: 'device', status: 'fail', detail: `Device check failed for ${vars.platform}` };
  }
}

async function checkDevServer(
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars: ProjectVars | undefined,
  devServerName: string,
  devServerLog: string,
): Promise<CheckStep[]> {
  const steps: CheckStep[] = [];
  const devCheck = expandHook('dev_server_check', projectJson, vars, projectVars);

  if (devCheck) {
    try {
      const result = await execOnSlot(vars, withMachineEnv(devCheck, vars));
      if (result.exitCode === 0) {
        const port = vars.resourceVars.port ?? '';
        steps.push({
          name: 'devserver',
          status: 'pass',
          detail: `${devServerName} running${port ? ` on port ${port}` : ''}`,
        });
      } else {
        const port = vars.resourceVars.port ?? '';
        steps.push({
          name: 'devserver',
          status: 'fail',
          detail: `${devServerName} not running${port ? ` on port ${port}` : ''}`,
        });
      }
    } catch {
      steps.push({ name: 'devserver', status: 'fail', detail: `${devServerName} check failed` });
    }
  } else {
    steps.push({
      name: 'devserver',
      status: 'skip',
      detail: 'No dev_server_check hook configured',
    });
  }

  // Check dev server log recency
  if (devServerLog) {
    const expandedLog = expandTemplate(devServerLog, vars, projectVars);
    try {
      const result = await execOnSlot(
        vars,
        `find ${shellQuote(`${vars.remoteRepo}/${expandedLog}`)} -mmin -5 2>/dev/null | grep -q .`,
      );
      if (result.exitCode === 0) {
        steps.push({ name: 'devserver.log', status: 'pass', detail: `${expandedLog} is recent` });
      } else {
        steps.push({
          name: 'devserver.log',
          status: 'warn',
          detail: `${expandedLog} missing or stale (>5 min)`,
        });
      }
    } catch {
      steps.push({ name: 'devserver.log', status: 'warn', detail: `${expandedLog} check failed` });
    }
  }

  return steps;
}

export async function checkHealth(
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars: ProjectVars | undefined,
  readyIndicator: string,
  parseHealthCmd: string,
  progress: HealthProgressOptions = {},
): Promise<CheckStep | null> {
  const onProgress = progress.onProgress ?? (() => {});
  const healthHook = expandHook('health_check', projectJson, vars, projectVars);
  if (!healthHook) return null;

  // First attempt
  let healthValue = await runHealthCheck(vars, healthHook, parseHealthCmd);

  if (healthValue && (!readyIndicator || healthValue === readyIndicator)) {
    return { name: 'health', status: 'pass', detail: `Health — ${healthValue}` };
  }

  // Try unlock + retry
  const unlockHook = expandHook('unlock', projectJson, vars, projectVars);
  let unlockFailure: string | null = null;
  if (unlockHook) {
    onProgress({
      name: 'health',
      status: 'warn',
      detail: `Health not ready (value=${healthValue || 'none'}) — trying unlock...`,
    });
    // Heartbeat through the unlock, the settle wait and the re-read: no window
    // may stay silent past the CLI's idle timeout.
    let phase = 'Unlock still running';
    await withHeartbeat(
      progress,
      'health',
      () => phase,
      async () => {
        unlockFailure = await runUnlockHook(vars, unlockHook);
        phase = 'Re-checking health after unlock';
        // Re-read health even after a failed unlock: the app can reach ready on its own.
        await new Promise((r) => setTimeout(r, 3000));
        healthValue = await runHealthCheck(vars, healthHook, parseHealthCmd);
      },
    );
    if (healthValue && (!readyIndicator || healthValue === readyIndicator)) {
      return { name: 'health', status: 'pass', detail: `Health after unlock — ${healthValue}` };
    }
  }

  const healthDetail = healthValue
    ? `Health responds but value=${healthValue} (expected ${readyIndicator})`
    : 'Health not responding';
  return {
    name: 'health',
    status: 'fail',
    detail: unlockFailure ? `${healthDetail}; ${unlockFailure}` : healthDetail,
  };
}

export interface HealthProgressOptions {
  /** Progress before and during a long unlock, so streaming clients see activity. */
  onProgress?: (step: CheckStep) => void;
  /** Heartbeat interval while the unlock and its health re-read run. */
  heartbeatMs?: number;
}

/**
 * Run `fn` while sending `<detail()> (<N> s)` as a warn step every
 * `heartbeatMs`, so no wait stays silent past the CLI's idle timeout.
 */
async function withHeartbeat<T>(
  progress: HealthProgressOptions,
  name: string,
  detail: () => string,
  fn: () => Promise<T>,
): Promise<T> {
  const onProgress = progress.onProgress ?? (() => {});
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedS = Math.round((Date.now() - startedAt) / 1000);
    onProgress({ name, status: 'warn', detail: `${detail()} (${elapsedS} s)` });
  }, progress.heartbeatMs ?? UNLOCK_HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Progress interval while the unlock hook runs: under the CLI's 30 s
 * no-activity timeout, which fleet broadcasts (also every 30 s) cannot be
 * relied on to beat.
 */
export const UNLOCK_HEARTBEAT_MS = 15_000;

/**
 * Bound for one unlock hook run. A timeout reports as exit 124, not a throw
 * (remote transport waits this budget plus a grace). On iOS sim slots the call
 * takes ~12 s; on a degraded physical Android slot (app detached) the harness
 * took 83-186 s before the action, so this bound does not cover that slot and
 * it reports the timeout instead.
 */
export const UNLOCK_HOOK_TIMEOUT_MS = 120_000;

/**
 * Run the project's unlock hook. Returns null when it exits 0, otherwise a
 * failure detail with the exit code and the tail of its output. Callers still
 * re-read health afterwards and report the failure only if health stays down.
 */
export async function runUnlockHook(vars: SlotVars, unlockHook: string): Promise<string | null> {
  const result = await execOnSlot(
    vars,
    withMachineEnv(`cd ${shellQuote(vars.remoteRepo)} && ${unlockHook} 2>&1`, vars),
    {
      timeout: UNLOCK_HOOK_TIMEOUT_MS,
    },
  );
  if (result.exitCode === 0) return null;
  const tail = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ');
  console.log(`[unlock] ${vars.slotId}: hook exited ${result.exitCode}: ${tail}`);
  return `unlock hook exited ${result.exitCode}${tail ? `: ${tail}` : ''}`;
}

async function checkCleanup(vars: SlotVars): Promise<CheckStep> {
  try {
    const result = await execOnSlot(
      vars,
      `cd ${shellQuote(vars.remoteRepo)} && ls benchmark-report.md 2>/dev/null`,
    );
    if (result.stdout.trim()) {
      await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && rm -f benchmark-report.md 2>/dev/null`,
      );
      return { name: 'cleanup', status: 'pass', detail: `Cleaned: benchmark-report.md` };
    }
    return { name: 'cleanup', status: 'pass', detail: 'No stale files' };
  } catch {
    return { name: 'cleanup', status: 'pass', detail: 'No stale files' };
  }
}

async function checkTmux(vars: SlotVars): Promise<CheckStep> {
  try {
    const session = await resolveTmuxSession(vars.slotId, vars);
    const result = await execOnSlot(
      vars,
      tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`),
    );
    if (result.exitCode === 0) {
      return { name: 'tmux', status: 'pass', detail: `tmux session ${session} exists` };
    }
    // Create it
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `new-session -d -s ${shellQuote(session)} -c ${shellQuote(vars.remoteRepo)}`,
      ),
    );
    return { name: 'tmux', status: 'pass', detail: `tmux session ${session} created` };
  } catch {
    return {
      name: 'tmux',
      status: 'warn',
      detail: `tmux session ${vars.session} could not be verified`,
    };
  }
}

// ─── Helpers ───

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

async function getRemoteMd5(vars: SlotVars, remotePath: string): Promise<string | null> {
  try {
    // Try md5sum first (Linux), then md5 -q (macOS)
    let result = await execOnSlot(
      vars,
      `md5sum ${shellQuote(remotePath)} 2>/dev/null | awk '{print $1}'`,
    );
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
    result = await execOnSlot(vars, `md5 -q ${shellQuote(remotePath)} 2>/dev/null`);
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
    return null;
  } catch {
    return null;
  }
}

export async function runHealthCheck(
  vars: SlotVars,
  healthHook: string,
  parseHealthCmd: string,
  options: {
    timeoutMs?: number;
    logPrefix?: string;
    projectJson?: RawProjectJson;
    projectVars?: ProjectVars;
  } = {},
): Promise<string> {
  try {
    const result = await execOnSlot(
      vars,
      withProjectMachineEnv(
        `cd ${shellQuote(vars.remoteRepo)} && ${healthHook} 2>/dev/null`,
        vars,
        options.projectJson ?? {},
        options.projectVars,
      ),
      { timeout: options.timeoutMs },
    );
    const raw = result.stdout.trim();
    console.log(
      `[${options.logPrefix ?? 'prepare'}] health check: cmd="${healthHook}" raw="${raw}" exit=${result.exitCode} stderr="${result.stderr.slice(0, 100)}"`,
    );
    if (result.exitCode !== 0) return '';
    if (!raw) return '';
    if (!parseHealthCmd) return raw;
    const { execLocal } = await import('../../core/exec.js');
    const parsed = await execLocal(`echo '${raw.replaceAll("'", "'\\''")}' | ${parseHealthCmd}`);
    return parsed.stdout.trim();
  } catch {
    return '';
  }
}
