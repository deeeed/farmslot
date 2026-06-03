// thumbnail-cache.ts — Demand-driven screenshot polling + in-memory cache for fleet thumbnails
// Only polls when at least one client is subscribed (viewing fleet page).

import { Events, type SlotStatus } from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { getNode } from '../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../fleet/node-rpc.js';
import { getCachedFleet } from '../fleet/state.js';
import { resolveSlotStreamAsync } from '../methods/stream-resolve.js';

interface ThumbnailEntry {
  data: string; // base64 PNG
  width: number;
  height: number;
  ts: number;
}

const cache = new Map<string, ThumbnailEntry>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let broadcastFn: ((event: string, payload: unknown) => void) | null = null;
let subscriberCount = 0;
let intervalMs = 15_000;
let pollInFlight = false;

export function getThumbnail(slotId: string): ThumbnailEntry | null {
  return cache.get(slotId) ?? null;
}

export function getAllThumbnails(): Record<string, ThumbnailEntry> {
  const out: Record<string, ThumbnailEntry> = {};
  for (const [k, v] of cache) out[k] = v;
  return out;
}

export function shouldPollThumbnailForSlot(slot: SlotStatus): boolean {
  if (slot.lifecycle === 'disabled') return false;
  if (!slot.currentRunId || (slot.lifecycle !== 'busy' && slot.lifecycle !== 'held')) return false;
  if (!slot.health?.device || slot.health.device.includes('OFF')) return false;
  return true;
}

export function subscribeThumbnails(): void {
  subscriberCount++;
  if (subscriberCount === 1) startPolling();
}

export function unsubscribeThumbnails(): void {
  subscriberCount = Math.max(0, subscriberCount - 1);
  if (subscriberCount === 0) stopPolling();
}

async function pollThumbnails(): Promise<void> {
  if (subscriberCount === 0) return;
  if (pollInFlight) {
    console.log('[thumbnail] skipping poll because previous poll is still running');
    return;
  }

  pollInFlight = true;

  try {
    const fleet = getCachedFleet();
    if (!fleet) return;

    const activeSlots = fleet.slots.filter((s) => shouldPollThumbnailForSlot(s));

    const startMs = Date.now();
    let updated = false;
    let succeeded = 0;
    let failed = 0;

    for (const slot of activeSlots) {
      try {
        let machine: string | undefined;
        try {
          const locality = await getSlotLocality(slot.slot);
          machine = locality.machine;
        } catch (err) {
          console.warn(`[thumbnail] skip ${slot.slot}: ${(err as Error).message}`);
          continue;
        }

        const node = machine ? getNode(machine) : undefined;
        if (!node) continue;

        const devInfo = await resolveSlotStreamAsync(slot.slot);
        // For browser platforms, resolve CDP port + repo paths so node can take screenshot
        let cdpPort: number | undefined;
        let repo: string | undefined;
        let runtimeDir: string | undefined;
        if (slot.platform === 'chrome-extension' || slot.platform === 'web') {
          const sv = await loadSlotVars(slot.slot);
          const pv = await loadProjectVars(sv.projectName);
          cdpPort = parseInt(sv.resourceVars.cdp_port, 10) || undefined;
          repo = sv.remoteRepo;
          runtimeDir = pv.runtimeDir;
        }

        const result = await sendNodeRequest(node, 'screen.thumbnail', {
          slotId: slot.slot,
          platform: slot.platform,
          maxWidth: 180,
          iosSimulator: devInfo.iosWindowName,
          androidSerial: devInfo.androidSerial,
          cdpPort,
          repo,
          runtimeDir,
        });

        if (result && typeof result === 'object' && 'data' in result) {
          const entry = result as ThumbnailEntry;
          cache.set(slot.slot, {
            data: entry.data,
            width: entry.width,
            height: entry.height,
            ts: entry.ts ?? Date.now(),
          });
          updated = true;
          succeeded++;
        }
      } catch (err) {
        failed++;
        console.log(`[thumbnail] fail ${slot.slot}: ${(err as Error).message}`);
      }
    }

    // Clean stale entries for slots no longer active
    const activeIds = new Set(activeSlots.map((s) => s.slot));
    for (const key of cache.keys()) {
      if (!activeIds.has(key)) cache.delete(key);
    }

    const elapsed = Date.now() - startMs;
    console.log(
      `[thumbnail] poll: ${succeeded} ok, ${failed} fail, ${activeSlots.length} slots, ${elapsed}ms, subscribers=${subscriberCount}`,
    );

    if (updated && broadcastFn) {
      broadcastFn(Events.FLEET_THUMBNAILS_UPDATED, { thumbnails: getAllThumbnails() });
    }
  } finally {
    pollInFlight = false;
  }
}

function startPolling(): void {
  if (pollTimer) return;
  console.log(`[thumbnail] starting polling (${intervalMs}ms interval)`);
  pollTimer = setInterval(() => {
    pollThumbnails().catch((err) => {
      console.error(`[thumbnail] poll error: ${(err as Error).message}`);
    });
  }, intervalMs);
  pollThumbnails().catch((err) => {
    console.error(`[thumbnail] initial poll error: ${(err as Error).message}`);
  });
}

function stopPolling(): void {
  if (!pollTimer) return;
  console.log('[thumbnail] stopping polling (no subscribers)');
  clearInterval(pollTimer);
  pollTimer = null;
}

export function initThumbnailCache(
  broadcast: (event: string, payload: unknown) => void,
  interval = 15_000,
): void {
  broadcastFn = broadcast;
  intervalMs = interval;
  // Don't start polling — wait for first subscriber
}
