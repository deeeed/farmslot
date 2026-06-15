// methods/fleet.ts — fleet.status, fleet.refresh (native TS)

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FleetStatusParams, FleetStatusResult } from '@farmslot/protocol';

import {
  execOnSlot,
  expandHook,
  expandPlatformField,
  farmslotRoot,
  getProjectField,
  isLocal,
  loadProjectVars,
  loadSlotVars,
  poolDir,
  type ProjectVars,
  type RawPoolJson,
  type RawProjectJson,
  readSlotField,
  renderFixtureTemplate,
  type SlotVars,
} from '../core/index.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import { loadFleetStatus } from '../fleet/state.js';
import { runnerProcessPatternSource } from '../runners/registry.js';

const statusFile = path.join(farmslotRoot, '.farm-status.json');
const LOCAL_SLOT_CHECK_CONCURRENCY = 4;
const SLOT_CHECK_TIMEOUT_MS = 5_000;

let fleetRefreshInFlight: Promise<FleetStatusResult> | null = null;

export async function fleetStatus(params?: FleetStatusParams): Promise<FleetStatusResult> {
  const fleet = await loadFleetStatus(params?.forceRefresh);
  return { fleet };
}

// ─── fleetRefresh — native TS port of farm-status.sh collect mode ───

interface SlotCheckResult {
  slot: string;
  machine: string;
  platform: string;
  project: string;
  ssh: string;
  dev: string;
  devserver: string;
  device: string;
  cdp: string;
  fixtures: string;
  branch: string;
  agent: string;
  enabled: boolean;
  mode: string;
  dispatchable: boolean;
  resources?: Record<string, Record<string, string | number | boolean>>;
}

interface PreviousSlotStatus {
  lifecycle?: string | null;
  phase?: string | null;
  warm?: boolean | null;
  task_id?: string | null;
  task_file?: string | null;
  current_run_id?: string | null;
  current_flow_type?: string | null;
  current_ticket_or_pr?: string | null;
  current_mode?: string | null;
  current_family_id?: string | null;
  current_lane?: string | null;
  current_variant?: string | null;
  dispatched_at?: string | null;
  completed_at?: string | null;
  runner?: string | null;
  model?: string | null;
}

export async function fleetRefresh(): Promise<FleetStatusResult> {
  if (fleetRefreshInFlight) return fleetRefreshInFlight;
  fleetRefreshInFlight = runFleetRefresh();
  try {
    return await fleetRefreshInFlight;
  } finally {
    fleetRefreshInFlight = null;
  }
}

async function runFleetRefresh(): Promise<FleetStatusResult> {
  // 1. Load all pool JSONs
  const pools = await loadAllPools();
  if (pools.length === 0) {
    return { fleet: await loadFleetStatus(true) };
  }

  // 2. Build flat slot list
  const slotEntries: Array<{ pool: RawPoolJson; slotIdx: number }> = [];
  for (const pool of pools) {
    for (let i = 0; i < pool.slots.length; i++) {
      slotEntries.push({ pool, slotIdx: i });
    }
  }

  // 3. Check SSH connectivity per unique machine
  const sshStatus = await checkSSHPerMachine(pools);

  // 4. Check each slot (local in parallel, respecting machine grouping)
  const results = await checkAllSlots(slotEntries, sshStatus);

  // 5. Load previous status to preserve lifecycle fields
  const prevSlots: Record<string, PreviousSlotStatus> = {};
  if (existsSync(statusFile)) {
    try {
      const prev = JSON.parse(await readFile(statusFile, 'utf-8'));
      for (const s of prev.slots ?? []) {
        prevSlots[s.slot] = s;
      }
    } catch {
      /* ignore corrupt file */
    }
  }

  // 6. Build final JSON and write
  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const slots = results.map((r) => {
    const prev = prevSlots[r.slot] ?? {};

    // Map pool mode + old lifecycle values to new 5-state model.
    let lifecycle: string;
    let phase: string | null = (prev.phase as string | null) ?? null;
    let warm: boolean = (prev.warm as boolean | undefined) ?? false;
    const prevLifecycle = prev.lifecycle as string | undefined;
    if (r.mode === 'disabled') {
      lifecycle = 'disabled';
      phase = null;
    } else if (r.mode === 'custom') {
      lifecycle = 'manual';
      phase = null;
    } else if (
      prevLifecycle === 'custom' ||
      prevLifecycle === 'disabled' ||
      prevLifecycle === 'manual'
    ) {
      lifecycle = 'ready';
      phase = null;
    } else {
      // Migrate old lifecycle values to new model
      switch (prevLifecycle) {
        case 'released':
          lifecycle = 'ready';
          phase = null;
          warm = false;
          break;
        case 'preparing':
          lifecycle = 'busy';
          phase = 'preparing';
          break;
        case 'dispatching':
          lifecycle = 'busy';
          phase = 'dispatching';
          break;
        case 'working':
          lifecycle = 'busy';
          phase = 'working';
          break;
        case 'releasing':
          lifecycle = 'busy';
          phase = 'releasing';
          break;
        case 'review-gate':
          lifecycle = 'busy';
          phase = 'review-gate';
          break;
        case 'ci-watch':
          lifecycle = 'held';
          phase = 'ci-watch';
          break;
        default:
          lifecycle = prevLifecycle ?? 'ready';
          break;
      }
    }

    return {
      slot: r.slot,
      machine: r.machine,
      platform: r.platform,
      project: r.project,
      ssh: r.ssh,
      dev: r.dev,
      devserver: r.devserver,
      device: r.device,
      cdp: r.cdp,
      fixtures: r.fixtures,
      branch: r.branch,
      agent: r.agent,
      enabled: r.enabled,
      mode: r.mode,
      dispatchable: r.dispatchable,
      lifecycle,
      phase,
      warm,
      task_id: prev.task_id ?? null,
      task_file: prev.task_file ?? null,
      current_run_id: prev.current_run_id ?? null,
      current_flow_type: prev.current_flow_type ?? null,
      current_ticket_or_pr: prev.current_ticket_or_pr ?? null,
      current_mode: prev.current_mode ?? null,
      current_family_id: prev.current_family_id ?? null,
      current_lane: prev.current_lane ?? null,
      current_variant: prev.current_variant ?? null,
      dispatched_at: prev.dispatched_at ?? null,
      completed_at: prev.completed_at ?? null,
      runner: prev.runner ?? null,
      model: prev.model ?? null,
      ...(r.resources ? { resources: r.resources } : {}),
    };
  });

  const tmpFile = `${statusFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpFile, JSON.stringify({ checked_at: checkedAt, slots }, null, 2) + '\n');
  await rename(tmpFile, statusFile);

  const fleet = await loadFleetStatus(true);
  return { fleet };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Load all pool JSONs ───

async function loadAllPools(): Promise<RawPoolJson[]> {
  const pools: RawPoolJson[] = [];
  try {
    const files = await readdir(poolDir);
    for (const file of files.sort()) {
      if (!file.endsWith('.json') || file === 'example.json') continue;
      try {
        const content = await readFile(path.join(poolDir, file), 'utf-8');
        pools.push(JSON.parse(content));
      } catch {
        /* skip */
      }
    }
  } catch {
    /* pool dir missing */
  }
  return pools;
}

// ─── Check SSH per unique machine ───

async function checkSSHPerMachine(
  pools: RawPoolJson[],
): Promise<Map<string, 'local' | 'ok' | 'fail' | 'skip'>> {
  const status = new Map<string, 'local' | 'ok' | 'fail' | 'skip'>();
  const seen = new Set<string>();

  const checks: Array<Promise<void>> = [];

  for (const pool of pools) {
    const key = pool.host;
    if (seen.has(key)) continue;
    seen.add(key);

    // Skip probe if all slots disabled
    const hasEnabled = pool.slots.some((s) => {
      const mode = s.mode || (s.enabled === false ? 'disabled' : 'dispatch');
      return mode !== 'disabled';
    });

    if (isLocal(pool.host, pool.machine)) {
      status.set(key, 'local');
    } else if (!hasEnabled) {
      status.set(key, 'skip');
    } else {
      checks.push(
        (async () => {
          try {
            const vars = await loadSlotVars(pool.slots[0].id);
            const result = await execOnSlot(vars, 'echo ok', { timeout: SLOT_CHECK_TIMEOUT_MS });
            status.set(key, result.exitCode === 0 ? 'ok' : 'fail');
          } catch {
            status.set(key, 'fail');
          }
        })(),
      );
    }
  }

  await Promise.all(checks);
  return status;
}

// ─── Check all slots ───

async function checkAllSlots(
  entries: Array<{ pool: RawPoolJson; slotIdx: number }>,
  sshStatus: Map<string, 'local' | 'ok' | 'fail' | 'skip'>,
): Promise<SlotCheckResult[]> {
  // Group by machine for parallel execution
  const byMachine = new Map<string, Array<{ pool: RawPoolJson; slotIdx: number }>>();
  for (const entry of entries) {
    const key = entry.pool.machine;
    if (!byMachine.has(key)) byMachine.set(key, []);
    byMachine.get(key)!.push(entry);
  }

  const allResults: SlotCheckResult[] = [];

  // Run all machines in parallel
  const machinePromises = Array.from(byMachine.entries()).map(
    async ([_machine, machineEntries]) => {
      const pool = machineEntries[0].pool;
      const local = isLocal(pool.host, pool.machine);

      if (local) {
        const results = await mapWithConcurrency(
          machineEntries,
          LOCAL_SLOT_CHECK_CONCURRENCY,
          (e) => checkSingleSlot(e.pool, e.slotIdx, sshStatus),
        );
        return results;
      } else {
        // Remote: run sequentially (node-rpc is per-machine)
        const results: SlotCheckResult[] = [];
        for (const e of machineEntries) {
          results.push(await checkSingleSlot(e.pool, e.slotIdx, sshStatus));
        }
        return results;
      }
    },
  );

  const machineResults = await Promise.all(machinePromises);
  for (const results of machineResults) {
    allResults.push(...results);
  }

  // Sort by original order
  const orderMap = new Map(entries.map((e, i) => [e.pool.slots[e.slotIdx].id, i]));
  allResults.sort((a, b) => (orderMap.get(a.slot) ?? 0) - (orderMap.get(b.slot) ?? 0));

  return allResults;
}

// ─── Check a single slot ───

async function checkSingleSlot(
  pool: RawPoolJson,
  slotIdx: number,
  sshStatus: Map<string, 'local' | 'ok' | 'fail' | 'skip'>,
): Promise<SlotCheckResult> {
  const rawSlot = pool.slots[slotIdx];
  const sid = rawSlot.id;
  const slotProject = rawSlot.project || pool.project || '';

  // Determine mode
  let mode = rawSlot.mode || '';
  if (!mode) mode = rawSlot.enabled === false ? 'disabled' : 'dispatch';

  const platform = rawSlot.platform || pool.platform;
  const deviceName =
    platform === 'android'
      ? (rawSlot.resources?.['android-emu']?.avd as string) || ''
      : (rawSlot.resources?.['ios-sim']?.simulator as string) || '';

  // Short-circuit disabled slots
  if (mode === 'disabled') {
    return {
      slot: sid,
      machine: pool.machine,
      platform,
      project: slotProject,
      ssh: '-',
      dev: '-',
      devserver: '-',
      device: deviceName,
      cdp: '-',
      fixtures: '-',
      branch: '-',
      agent: '-',
      enabled: false,
      mode: 'disabled',
      dispatchable: false,
    };
  }

  // Check SSH for this machine
  const ssh = sshStatus.get(pool.host) ?? 'fail';
  if (ssh === 'fail' || ssh === 'skip') {
    return {
      slot: sid,
      machine: pool.machine,
      platform,
      project: slotProject,
      ssh: 'FAIL',
      dev: '-',
      devserver: '-',
      device: deviceName,
      cdp: '-',
      fixtures: '-',
      branch: '-',
      agent: '-',
      enabled: true,
      mode,
      dispatchable: false,
    };
  }

  const sshStr = ssh === 'local' ? 'LOCAL' : 'OK';

  // Load slot vars and project config
  let vars: SlotVars;
  try {
    vars = await loadSlotVars(sid);
  } catch {
    return {
      slot: sid,
      machine: pool.machine,
      platform,
      project: slotProject,
      ssh: sshStr,
      dev: '-',
      devserver: '-',
      device: deviceName,
      cdp: '-',
      fixtures: '-',
      branch: '-',
      agent: '-',
      enabled: true,
      mode,
      dispatchable: false,
    };
  }

  let projectVars: ProjectVars | undefined;
  let projectJson: RawProjectJson = {};
  try {
    projectVars = await loadProjectVars(slotProject);
    projectJson = projectVars.projectJson;
  } catch {
    /* no project config */
  }

  // Run all checks in parallel for this slot
  const [branchStr, agentStr, emuStr, devserverStr, cdpStr, fixStr] = await Promise.all([
    checkBranch(vars),
    checkAgent(vars),
    checkDevice(vars, projectJson, projectVars),
    checkDevServer(vars, projectJson, projectVars),
    checkCDP(vars, projectJson, projectVars),
    checkFixtures(vars, projectVars, projectJson),
  ]);

  const dispatchable =
    mode === 'dispatch' &&
    (sshStr === 'OK' || sshStr === 'LOCAL') &&
    (emuStr === '-' || emuStr.endsWith(':OK')) &&
    (devserverStr === '-' || devserverStr === 'OK') &&
    cdpStr !== 'FAIL' &&
    agentStr !== 'working';

  return {
    slot: sid,
    machine: pool.machine,
    platform,
    project: slotProject,
    ssh: sshStr,
    dev: emuStr,
    devserver: devserverStr,
    device: deviceName,
    cdp: cdpStr,
    fixtures: fixStr,
    branch: branchStr,
    agent: agentStr,
    enabled: true,
    mode,
    dispatchable,
    resources: rawSlot.resources,
  };
}

// ─── Individual check helpers ───

async function checkBranch(vars: SlotVars): Promise<string> {
  try {
    const r = await execOnSlot(
      vars,
      `git -C '${vars.remoteRepo}' rev-parse --abbrev-ref HEAD 2>/dev/null`,
      { timeout: SLOT_CHECK_TIMEOUT_MS },
    );
    return r.stdout.trim() || '-';
  } catch {
    return '-';
  }
}

async function checkAgent(vars: SlotVars): Promise<string> {
  if (!vars.session) return '-';
  try {
    const session = await resolveTmuxSession(vars.slotId, vars, { strict: true });
    const r = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(session)} -F '#{pane_pid}' 2>/dev/null | head -1`,
      ),
      { timeout: SLOT_CHECK_TIMEOUT_MS },
    );
    const panePid = r.stdout.trim();
    if (!panePid) return 'no-tmux';
    const runner = (await readSlotField(vars.slotId, 'runner')) as string | null;
    const agentPattern = runnerProcessPatternSource(runner ?? undefined);
    const a = await execOnSlot(vars, `pgrep -P '${panePid}' -f '${agentPattern}' >/dev/null 2>&1`, {
      timeout: SLOT_CHECK_TIMEOUT_MS,
    });
    const status = a.exitCode === 0 ? 'working' : 'idle';
    if (status === 'working') {
      console.log(
        `[fleet] checkAgent ${vars.slotId}: working (panePid=${panePid}, session=${session}, runner=${runner ?? 'auto'})`,
      );
    }
    return status;
  } catch {
    return 'no-tmux';
  }
}

async function checkDevice(vars: SlotVars, pj: RawProjectJson, pv?: ProjectVars): Promise<string> {
  const cmd = expandPlatformField('device_check', pj, vars, pv);
  if (!cmd) {
    // Fallback
    const adbSerial = vars.resourceVars.adb_serial ?? '';
    if (vars.platform === 'android' && adbSerial) {
      try {
        const r = await execOnSlot(vars, `adb devices 2>/dev/null | grep -q '${adbSerial}'`, {
          timeout: SLOT_CHECK_TIMEOUT_MS,
        });
        return r.exitCode === 0 ? 'emu:OK' : 'emu:OFF';
      } catch {
        return 'emu:OFF';
      }
    }
    const iosSim = vars.resourceVars.simulator ?? '';
    if (vars.platform === 'ios' && iosSim) {
      try {
        const r = await execOnSlot(
          vars,
          `xcrun simctl list devices booted 2>/dev/null | grep -q '${iosSim}'`,
          { timeout: SLOT_CHECK_TIMEOUT_MS },
        );
        return r.exitCode === 0 ? 'sim:OK' : 'sim:OFF';
      } catch {
        return 'sim:OFF';
      }
    }
    return '-';
  }
  try {
    const r = await execOnSlot(vars, cmd, { timeout: SLOT_CHECK_TIMEOUT_MS });
    const prefix = vars.platform === 'android' ? 'emu' : vars.platform === 'ios' ? 'sim' : 'ext';
    return r.exitCode === 0 ? `${prefix}:OK` : `${prefix}:OFF`;
  } catch {
    const prefix = vars.platform === 'android' ? 'emu' : vars.platform === 'ios' ? 'sim' : 'ext';
    return `${prefix}:OFF`;
  }
}

async function checkDevServer(
  vars: SlotVars,
  pj: RawProjectJson,
  pv?: ProjectVars,
): Promise<string> {
  const cmd = expandHook('dev_server_check', pj, vars, pv);
  if (cmd) {
    try {
      const r = await execOnSlot(vars, cmd, { timeout: SLOT_CHECK_TIMEOUT_MS });
      return r.exitCode === 0 ? 'OK' : 'OFF';
    } catch {
      return 'OFF';
    }
  }
  // Fallback: check port
  const port = parseInt(vars.resourceVars.port ?? '0', 10);
  if (port) {
    try {
      const r = await execOnSlot(
        vars,
        `ss -tln 2>/dev/null | grep -q ':${port} ' || lsof -nP -iTCP:${port} -sTCP:LISTEN -t >/dev/null 2>&1`,
        { timeout: SLOT_CHECK_TIMEOUT_MS },
      );
      return r.exitCode === 0 ? 'OK' : 'OFF';
    } catch {
      return 'OFF';
    }
  }
  return '-';
}

async function checkCDP(vars: SlotVars, pj: RawProjectJson, pv?: ProjectVars): Promise<string> {
  const healthCmd = expandHook('health_check', pj, vars, pv);
  if (!healthCmd) return '-';

  const parseCmd = getProjectField(pj, 'health.parse_health');
  try {
    const r = await execOnSlot(vars, `cd '${vars.remoteRepo}' && ${healthCmd} 2>/dev/null`, {
      timeout: SLOT_CHECK_TIMEOUT_MS,
    });
    const raw = r.stdout.trim();
    if (!raw) return 'OFF';
    if (!parseCmd) return 'OK';
    // Parse through project's parse command
    const { execLocal } = await import('../core/exec.js');
    const parsed = await execLocal(`echo '${raw.replace(/'/g, "'\\''")}' | ${parseCmd}`, {
      timeout: SLOT_CHECK_TIMEOUT_MS,
    });
    const val = parsed.stdout.trim();
    return val || 'Other';
  } catch {
    return 'OFF';
  }
}

async function checkFixtures(
  vars: SlotVars,
  pv: ProjectVars | undefined,
  pj: RawProjectJson,
): Promise<string> {
  if (!pv || !pj.fixtures) return '-';

  const templates = pj.fixtures.templates ?? [];
  let total = 0;
  let ok = 0;

  for (const tpl of templates) {
    if (!tpl.src) continue; // compose entries have no src — skip for fixture check
    const localPath = path.join(pv.projectFixturesDir, tpl.src);
    if (!existsSync(localPath)) continue;
    total++;
    try {
      const rendered = await renderFixtureTemplate(localPath, vars, pv);
      const localMd5 = md5(rendered);
      const remoteMd5 = await getRemoteMd5(vars, `${vars.remoteRepo}/${tpl.dst}`);
      if (remoteMd5 && localMd5 === remoteMd5) ok++;
    } catch {
      /* mismatch */
    }
  }

  // Check directories (sentinel-based)
  const directories = pj.fixtures?.directories ?? [];
  for (const dir of directories) {
    total++;
    try {
      const dirExists = await execOnSlot(vars, `test -d '${vars.remoteRepo}/${dir.dst}'`, {
        timeout: SLOT_CHECK_TIMEOUT_MS,
      });
      if (dirExists.exitCode !== 0) continue;
      if (dir.sentinel && pv) {
        const localSentinel = path.join(pv.projectFixturesDir, dir.src, dir.sentinel);
        if (existsSync(localSentinel)) {
          const content = await readFile(localSentinel, 'utf-8');
          const localMd5 = md5(content);
          const remoteMd5 = await getRemoteMd5(
            vars,
            `${vars.remoteRepo}/${dir.dst}/${dir.sentinel}`,
          );
          if (remoteMd5 && localMd5 === remoteMd5) ok++;
        } else {
          ok++; // dir exists, no local sentinel to compare
        }
      } else {
        ok++; // dir exists, no sentinel configured
      }
    } catch {
      /* mismatch */
    }
  }

  if (total === 0) return '-';
  if (ok === total) return 'OK';
  return `${ok}/${total}`;
}

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

async function getRemoteMd5(vars: SlotVars, remotePath: string): Promise<string | null> {
  try {
    let r = await execOnSlot(vars, `md5sum '${remotePath}' 2>/dev/null | awk '{print $1}'`, {
      timeout: SLOT_CHECK_TIMEOUT_MS,
    });
    if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
    r = await execOnSlot(vars, `md5 -q '${remotePath}' 2>/dev/null`, {
      timeout: SLOT_CHECK_TIMEOUT_MS,
    });
    if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
    return null;
  } catch {
    return null;
  }
}
