import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SlotCheckParams, SlotCheckResult } from '@farmslot/protocol';

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
} from '../../core/index.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../../core/tmux.js';
import { loadFleetStatus } from '../../fleet/state.js';

import { applySelectedApp, type CheckStep, type EventEmitter } from './shared.js';

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
    const result = await execOnSlot(vars, `test -d ${shellQuote(`${vars.remoteRepo}/.git`)}`);
    if (result.exitCode === 0) {
      return { name: 'repo', status: 'pass', detail: `Repo exists at ${vars.remoteRepo}` };
    }
    return { name: 'repo', status: 'fail', detail: `Repo not found at ${vars.remoteRepo}` };
  } catch {
    return { name: 'repo', status: 'fail', detail: `Repo not found at ${vars.remoteRepo}` };
  }
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
    const localPath = path.join(projectVars.projectFixturesDir, tpl.src);
    if (!existsSync(localPath)) {
      steps.push({
        name: `fixture:${dst}`,
        status: 'warn',
        detail: `Template ${tpl.src} not found locally`,
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
    const result = await execOnSlot(vars, deviceCheck);
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
      const result = await execOnSlot(vars, devCheck);
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

async function checkHealth(
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars: ProjectVars | undefined,
  readyIndicator: string,
  parseHealthCmd: string,
): Promise<CheckStep | null> {
  const healthHook = expandHook('health_check', projectJson, vars, projectVars);
  if (!healthHook) return null;

  // First attempt
  let healthValue = await runHealthCheck(vars, healthHook, parseHealthCmd);

  if (healthValue && (!readyIndicator || healthValue === readyIndicator)) {
    return { name: 'health', status: 'pass', detail: `Health — ${healthValue}` };
  }

  // Try unlock + retry
  const unlockHook = expandHook('unlock', projectJson, vars, projectVars);
  if (unlockHook) {
    try {
      await execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && ${unlockHook} 2>&1`);
      // Wait for unlock to take effect
      await new Promise((r) => setTimeout(r, 3000));
      healthValue = await runHealthCheck(vars, healthHook, parseHealthCmd);
      if (healthValue && (!readyIndicator || healthValue === readyIndicator)) {
        return { name: 'health', status: 'pass', detail: `Health after unlock — ${healthValue}` };
      }
    } catch {
      /* unlock failed, fall through */
    }
  }

  return {
    name: 'health',
    status: 'fail',
    detail: healthValue
      ? `Health responds but value=${healthValue} (expected ${readyIndicator})`
      : 'Health not responding',
  };
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
): Promise<string> {
  try {
    const result = await execOnSlot(
      vars,
      `cd ${shellQuote(vars.remoteRepo)} && ${healthHook} 2>/dev/null`,
    );
    const raw = result.stdout.trim();
    console.log(
      `[prepare] health check: cmd="${healthHook}" raw="${raw}" exit=${result.exitCode} stderr="${result.stderr.slice(0, 100)}"`,
    );
    if (!raw) return '';
    if (!parseHealthCmd) return raw;
    const { execLocal } = await import('../../core/exec.js');
    const parsed = await execLocal(`echo '${raw.replaceAll("'", "'\\''")}' | ${parseHealthCmd}`);
    return parsed.stdout.trim();
  } catch {
    return '';
  }
}
