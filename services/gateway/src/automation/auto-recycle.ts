// auto-recycle.ts — Periodic health scan: recycle unhealthy idle slots
// E3: only touches slots in ready/released with consecutive health failures

import { Events, type ProjectConfig, type SlotStatus } from '@farmslot/protocol';

import { loadFleetStatus, loadProjectConfigs } from '../fleet/state.js';
import { slotRecycle } from '../methods/slot.js';

type BroadcastFn = (event: string, payload: unknown) => void;

interface AutoRecycleConfig {
  enabled: boolean;
  intervalMs: number;
  maxFailures: number;
}

const DEFAULT_CONFIG: AutoRecycleConfig = {
  enabled: false,
  intervalMs: 5 * 60_000,
  maxFailures: 2,
};

// Consecutive failure count per slot
const failureCounts = new Map<string, number>();

// Active recycles — prevent overlapping recycles for the same slot
const recyclingSlots = new Set<string>();

let timer: ReturnType<typeof setInterval> | null = null;
let broadcastFn: BroadcastFn = () => {};

export function initAutoRecycle(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
  // Run first scan after a short delay, then schedule periodic
  const initialTimer = setTimeout(() => {
    runScan();
    scheduleScan();
  }, 30_000); // 30s after gateway start
  initialTimer.unref();
  console.log('[auto-recycle] initialized — first scan in 30s');
}

export function stopAutoRecycle(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function scheduleScan(): Promise<void> {
  // Load configs to find the shortest interval across all projects with auto_recycle enabled
  const config = await resolveConfig();
  if (!config.enabled) {
    console.log('[auto-recycle] disabled — no projects have auto_recycle.enabled=true');
    return;
  }

  if (timer) clearInterval(timer);
  timer = setInterval(() => runScan(), config.intervalMs);
  timer.unref();
  console.log(
    `[auto-recycle] scheduled every ${config.intervalMs / 60_000}min (maxFailures=${config.maxFailures})`,
  );
}

async function resolveConfig(): Promise<AutoRecycleConfig> {
  const projects = await loadProjectConfigs();
  let enabled = false;
  let shortestInterval = DEFAULT_CONFIG.intervalMs;
  let minFailures = DEFAULT_CONFIG.maxFailures;

  for (const proj of projects) {
    const ar = proj.auto_recycle;
    if (ar?.enabled) {
      enabled = true;
      if (ar.interval_min != null) {
        shortestInterval = Math.min(shortestInterval, ar.interval_min * 60_000);
      }
      if (ar.max_failures != null) {
        minFailures = Math.min(minFailures, ar.max_failures);
      }
    }
  }

  return { enabled, intervalMs: shortestInterval, maxFailures: minFailures };
}

function getProjectConfig(projects: ProjectConfig[], projectName: string): AutoRecycleConfig {
  const proj = projects.find((p) => p.name === projectName);
  const ar = proj?.auto_recycle;
  if (!ar?.enabled) return { ...DEFAULT_CONFIG, enabled: false };
  return {
    enabled: true,
    intervalMs: (ar.interval_min ?? 5) * 60_000,
    maxFailures: ar.max_failures ?? 2,
  };
}

function isSlotUnhealthy(slot: SlotStatus): boolean {
  const h = slot.health;
  // Check for any FAIL in the health fields we care about
  return h.ssh === 'FAIL' || h.devserver === 'FAIL' || h.cdp === 'FAIL';
}

async function runScan(): Promise<void> {
  try {
    const fleet = await loadFleetStatus(true); // force refresh
    const projects = await loadProjectConfigs();

    const idleSlots = fleet.slots.filter((s) => s.lifecycle === 'ready');

    let recycled = 0;
    let healthy = 0;

    for (const slot of idleSlots) {
      const config = getProjectConfig(projects, slot.project);
      if (!config.enabled) continue;

      if (recyclingSlots.has(slot.slot)) continue; // already recycling

      if (isSlotUnhealthy(slot)) {
        const count = (failureCounts.get(slot.slot) ?? 0) + 1;
        failureCounts.set(slot.slot, count);

        if (count >= config.maxFailures) {
          console.log(
            `[auto-recycle] slot ${slot.slot} unhealthy ${count}x — triggering recycle (ssh=${slot.health.ssh} devserver=${slot.health.devserver} cdp=${slot.health.cdp})`,
          );
          triggerRecycle(slot.slot);
          recycled++;
        } else {
          console.log(
            `[auto-recycle] slot ${slot.slot} unhealthy ${count}/${config.maxFailures} — waiting`,
          );
        }
      } else {
        // Healthy — reset failure count
        if (failureCounts.has(slot.slot)) {
          failureCounts.delete(slot.slot);
        }
        healthy++;
      }
    }

    console.log(
      `[auto-recycle] scan complete: ${idleSlots.length} idle slots checked, ${healthy} healthy, ${recycled} recycled`,
    );
  } catch (err) {
    console.error(`[auto-recycle] scan error: ${(err as Error).message}`);
  }
}

function triggerRecycle(slotId: string): void {
  recyclingSlots.add(slotId);
  failureCounts.delete(slotId);

  // Run recycle in background — no-op event handler since this is automated
  slotRecycle({ slotId }, (_event, _payload) => {
    // Log recycle progress at debug level
  })
    .then(() => {
      console.log(`[auto-recycle] slot ${slotId} recycle completed`);
      recyclingSlots.delete(slotId);
      // Broadcast fleet update so UI refreshes
      loadFleetStatus(true)
        .then((fleet) => {
          broadcastFn(Events.FLEET_UPDATED, { fleet });
        })
        .catch(() => {});
    })
    .catch((err) => {
      console.error(`[auto-recycle] slot ${slotId} recycle failed: ${(err as Error).message}`);
      recyclingSlots.delete(slotId);
    });
}
