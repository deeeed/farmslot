// chat/chat-context.ts — Build fleet context for co-pilot system prompt

import { listItems } from '../backlog/dispatch-queue.js';
import { getAllMachineHealth } from '../fleet/node-health.js';
import { getCachedFleet } from '../fleet/state.js';
import { decisionList } from '../methods/decisions.js';
import { listRuns } from '../runs/store.js';

import { getRecentEvents } from './copilot-observer.js';

const MAX_CHARS = 3000;
const FLEET_CONTEXT_TTL_MS = 5_000;

let fleetContextCache: { value: string; expiresAt: number } | null = null;

export async function buildFleetContext(): Promise<string> {
  const now = Date.now();
  if (fleetContextCache && now < fleetContextCache.expiresAt) {
    return fleetContextCache.value;
  }

  const fleet = getCachedFleet();
  const lines: string[] = [];

  // ── Slots ──
  if (fleet) {
    lines.push('### Slots\n');
    lines.push('| ID | Lifecycle | Agent | Branch | Phase |');
    lines.push('|---|---|---|---|---|');
    for (const slot of fleet.slots) {
      if (!slot.enabled) continue;
      const branch = slot.branch?.slice(0, 28) ?? '-';
      const phase = slot.taskPhase ?? '-';
      lines.push(`| ${slot.slot} | ${slot.lifecycle} | ${slot.agent} | ${branch} | ${phase} |`);
    }
    const s = fleet.summary;
    lines.push(`\n**Fleet:** ${s.total} slots — ${s.busy} busy, ${s.ready} ready, ${s.held} held`);
  } else {
    lines.push('(fleet state unavailable)');
  }

  // ── Machine health ──
  const machines = getAllMachineHealth();
  if (machines.length > 0) {
    lines.push('\n### Machine Health\n');
    lines.push('| Machine | CPU | Mem | Disk | Load | Headroom |');
    lines.push('|---------|-----|-----|------|------|----------|');
    for (const m of machines) {
      if (!m.system) {
        lines.push(`| ${m.machine} | ${m.online ? '?' : 'offline'} | - | - | - | ${m.headroom} |`);
      } else {
        const s = m.system;
        lines.push(
          `| ${m.machine} | ${s.cpuPercent}% | ${s.memoryPercent}% | ${s.diskPercent}% | ${s.loadAvg1} | ${m.headroom} |`,
        );
      }
    }
  }

  // ── Active runs ──
  const { runs: active } = listRuns({ active: true, limit: 20 });
  lines.push(
    `\n### Active Runs (source: run.list active=true, count=${active.length}, checkedAt=${new Date(now).toISOString()})\n`,
  );
  if (active.length === 0) {
    lines.push('No active runs.');
  } else {
    lines.push('| Run | Flow | Status | Step | Slot |');
    lines.push('|---|---|---|---|---|');
    for (const run of active) {
      const step = run.steps.find((s) => s.status === 'running')?.name ?? '-';
      const hasPending = run.decisions?.some((d) => !d.resolvedAt);
      const status = hasPending ? `${run.status} ⏳DECISION` : run.status;
      lines.push(
        `| ${run.id.slice(0, 8)} | ${run.flowType} | ${status} | ${step} | ${run.slotId ?? '-'} |`,
      );
    }
  }

  // ── Queue ──
  const queueItems = listItems();
  lines.push(
    `\n### Queue (source: dispatch.queue.list, count=${queueItems.length}, checkedAt=${new Date(now).toISOString()})\n`,
  );
  if (queueItems.length === 0) {
    lines.push('Queue is empty.');
  } else {
    for (const item of queueItems.slice(0, 10)) {
      lines.push(
        `- ${item.id.slice(0, 8)} ${item.flowType} ${item.project}/${item.ticketOrPr} priority=${item.priority}`,
      );
    }
  }

  // ── Pending decisions ──
  const { decisions } = await decisionList();
  lines.push(
    `\n### Pending Decisions (source: decision.list, count=${decisions.length}, checkedAt=${new Date(now).toISOString()})\n`,
  );
  if (decisions.length === 0) {
    lines.push('No pending decisions.');
  } else {
    for (const d of decisions) {
      const age = Math.round((now - new Date(d.createdAt).getTime()) / 60000);
      const runId = d.context?.runId ? String(d.context.runId).slice(0, 8) : 'legacy';
      const ticket = d.context?.ticketOrPr
        ? String(d.context.ticketOrPr)
        : (d.runMeta?.ticketOrPr ?? '-');
      lines.push(`- Run ${runId} (${ticket}): "${d.title.slice(0, 80)}" — waiting ${age}min`);
    }
  }

  // ── Recent activity (last 2h from observer) ──
  const events = getRecentEvents();
  if (events.length > 0) {
    lines.push('\n### Recent Activity (last 2h)\n');
    // Most recent first, capped at 15 entries
    for (const e of [...events].reverse().slice(0, 15)) {
      const time = e.ts.slice(11, 16);
      const badge =
        e.severity === 'error' ? '[ERROR]' : e.severity === 'warn' ? '[WARN]' : '[INFO]';
      lines.push(`- ${time} ${badge} ${e.type}: ${e.summary}`);
    }
  }

  const result = lines.join('\n');
  const value =
    result.length > MAX_CHARS ? result.slice(0, MAX_CHARS) + '\n...(truncated)' : result;
  fleetContextCache = { value, expiresAt: now + FLEET_CONTEXT_TTL_MS };
  return value;
}
