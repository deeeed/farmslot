import {
  isTerminalRunStatus,
  type NodeProcessInventory,
  type NodeProcessSample,
  type ProcessAttributionConfidence,
  type ProcessAttributionGroup,
  type ProcessOwnershipClass,
  type ResourceStatus,
  type Run,
  type SlotStatus,
  type TmuxWorkerSummary,
} from '@farmslot/protocol';

const MAX_ATTRIBUTION_GROUPS = 32;
const MAX_ANCESTRY_DEPTH = 64;

export interface ProcessAttributionResource {
  pid: number;
  slotId: string;
  resourceId: string;
  runId: string | null;
  status: ResourceStatus;
}

export interface ProcessAttributionResult {
  groups: ProcessAttributionGroup[];
  omittedGroups: number;
  classCounts: Record<ProcessOwnershipClass, number>;
}

interface OwnerSeed {
  pid: number;
  classification: ProcessOwnershipClass;
  confidence: ProcessAttributionConfidence;
  evidence: string[];
  slotId?: string;
  runId?: string;
  resourceId?: string;
  tmuxTarget?: string;
}

const EMPTY_CLASS_COUNTS: Record<ProcessOwnershipClass, number> = {
  active: 0,
  retained: 0,
  stale: 0,
  manual: 0,
  unknown: 0,
};

function classifyWorker(
  worker: TmuxWorkerSummary,
  slotById: Map<string, SlotStatus>,
  runById: Map<string, Run>,
): OwnerSeed | null {
  if (!worker.pid) return null;
  const cwd = worker.cwd;
  const inferredSlot = cwd
    ? [...slotById.values()]
        .filter((slot) => slot.repo && (cwd === slot.repo || cwd.startsWith(`${slot.repo}/`)))
        .sort((a, b) => (b.repo?.length ?? 0) - (a.repo?.length ?? 0))[0]
    : undefined;
  const slotId = worker.linkedSlotId ?? inferredSlot?.slot;
  const slot = slotId ? slotById.get(slotId) : undefined;
  const runId = worker.linkedRunId ?? slot?.currentRunId ?? undefined;
  const run = runId ? runById.get(runId) : undefined;
  const base = {
    pid: worker.pid,
    ...(slotId ? { slotId } : {}),
    ...(runId ? { runId } : {}),
    tmuxTarget: worker.ref.target,
  };

  if (runId && !run) {
    return {
      ...base,
      classification: 'stale',
      confidence: 'high',
      evidence: [`tmux:${worker.ref.target}`, `missing-run:${runId}`],
    };
  }
  if (run && !isTerminalRunStatus(run.status)) {
    return {
      ...base,
      classification: 'active',
      confidence: 'high',
      evidence: [`tmux:${worker.ref.target}`, `active-run:${run.id}`],
    };
  }
  if (run) {
    const mismatchedOwner = Boolean(slot?.currentRunId && slot.currentRunId !== run.id);
    if (worker.status.state === 'stale' || mismatchedOwner) {
      return {
        ...base,
        classification: 'stale',
        confidence: 'high',
        evidence: [
          `tmux:${worker.ref.target}`,
          `terminal-run:${run.id}`,
          mismatchedOwner ? `slot-owner:${slot?.currentRunId}` : 'stale-worker-signal',
        ],
      };
    }
    return {
      ...base,
      classification: 'retained',
      confidence: 'high',
      evidence: [`tmux:${worker.ref.target}`, `terminal-run:${run.id}`],
    };
  }
  if (slot?.lifecycle === 'busy') {
    return {
      ...base,
      classification: 'active',
      confidence: 'medium',
      evidence: [`tmux:${worker.ref.target}`, `busy-slot:${slot.slot}`],
    };
  }
  if (slot?.lifecycle === 'held') {
    return {
      ...base,
      classification: 'retained',
      confidence: 'medium',
      evidence: [`tmux:${worker.ref.target}`, `held-slot:${slot.slot}`],
    };
  }
  return {
    ...base,
    classification: 'manual',
    confidence: slot ? 'high' : 'medium',
    evidence: [
      `tmux:${worker.ref.target}`,
      slot ? `${slot.lifecycle}-slot:${slot.slot}` : 'unlinked-tmux-session',
    ],
  };
}

function classifyResource(
  resource: ProcessAttributionResource,
  slotById: Map<string, SlotStatus>,
  runById: Map<string, Run>,
): OwnerSeed {
  const slot = slotById.get(resource.slotId);
  const run = resource.runId ? runById.get(resource.runId) : undefined;
  const base = {
    pid: resource.pid,
    slotId: resource.slotId,
    resourceId: resource.resourceId,
    ...(resource.runId ? { runId: resource.runId } : {}),
  };
  if (resource.runId && !run) {
    return {
      ...base,
      classification: 'stale',
      confidence: 'high',
      evidence: [
        `resource:${resource.slotId}/${resource.resourceId}`,
        `missing-run:${resource.runId}`,
      ],
    };
  }
  if (run && !isTerminalRunStatus(run.status)) {
    return {
      ...base,
      classification: 'active',
      confidence: 'high',
      evidence: [`resource:${resource.slotId}/${resource.resourceId}`, `active-run:${run.id}`],
    };
  }
  if (resource.status === 'stale' || (run && slot?.currentRunId && slot.currentRunId !== run.id)) {
    return {
      ...base,
      classification: 'stale',
      confidence: 'high',
      evidence: [
        `resource:${resource.slotId}/${resource.resourceId}`,
        resource.status === 'stale' ? 'stale-resource-status' : `slot-owner:${slot?.currentRunId}`,
      ],
    };
  }
  if (run) {
    return {
      ...base,
      classification: 'retained',
      confidence: 'high',
      evidence: [`resource:${resource.slotId}/${resource.resourceId}`, `terminal-run:${run.id}`],
    };
  }
  if (slot?.lifecycle === 'busy') {
    return {
      ...base,
      classification: 'active',
      confidence: 'medium',
      evidence: [`resource:${resource.slotId}/${resource.resourceId}`, `busy-slot:${slot.slot}`],
    };
  }
  return {
    ...base,
    classification: 'retained',
    confidence: 'medium',
    evidence: [`resource:${resource.slotId}/${resource.resourceId}`, 'configured-resource'],
  };
}

function highestSampledAncestor(
  process: NodeProcessSample,
  byPid: Map<number, NodeProcessSample>,
): NodeProcessSample {
  let current = process;
  const visited = new Set<number>();
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    if (visited.has(current.pid)) break;
    visited.add(current.pid);
    const parent = byPid.get(current.ppid);
    if (!parent || parent.pid === 1) break;
    current = parent;
  }
  return current;
}

function nearestOwner(
  process: NodeProcessSample,
  byPid: Map<number, NodeProcessSample>,
  seeds: Map<number, OwnerSeed>,
): OwnerSeed | null {
  let current: NodeProcessSample | undefined = process;
  const visited = new Set<number>();
  for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    if (visited.has(current.pid)) break;
    visited.add(current.pid);
    const seed = seeds.get(current.pid);
    if (seed) return seed;
    current = byPid.get(current.ppid);
  }
  return null;
}

export function attributeProcessInventory(params: {
  inventory: NodeProcessInventory;
  workers: TmuxWorkerSummary[];
  slots: SlotStatus[];
  runs: Run[];
  resources: ProcessAttributionResource[];
  maxGroups?: number;
}): ProcessAttributionResult {
  const slotById = new Map(params.slots.map((slot) => [slot.slot, slot]));
  const runById = new Map(params.runs.map((run) => [run.id, run]));
  const byPid = new Map(params.inventory.processes.map((process) => [process.pid, process]));
  const seeds = new Map<number, OwnerSeed>();

  for (const resource of params.resources) {
    if (byPid.has(resource.pid))
      seeds.set(resource.pid, classifyResource(resource, slotById, runById));
  }
  for (const worker of params.workers) {
    const seed = classifyWorker(worker, slotById, runById);
    if (!seed || !byPid.has(seed.pid)) continue;
    if (seed.runId || seed.slotId || !seeds.has(seed.pid)) seeds.set(seed.pid, seed);
  }

  const groups = new Map<string, ProcessAttributionGroup & { cpuRaw: number; rssRaw: number }>();
  for (const process of params.inventory.processes) {
    let owner = nearestOwner(process, byPid, seeds);
    const root = owner ? (byPid.get(owner.pid) ?? process) : highestSampledAncestor(process, byPid);
    if (!owner && /(?:^|\/)tmux$/u.test(root.executable)) {
      owner = {
        pid: root.pid,
        classification: 'manual',
        confidence: 'low',
        evidence: ['unmapped-tmux-ancestry'],
      };
    }
    const key = owner ? `owned:${owner.pid}` : `unknown:${root.pid}`;
    const existing = groups.get(key);
    if (existing) {
      existing.processCount += 1;
      existing.cpuRaw += process.cpuPercent;
      existing.rssRaw += process.rssBytes;
      if (
        process.cpuPercent > existing.topCpuPercent ||
        (process.cpuPercent === existing.topCpuPercent && process.rssBytes > existing.topRssBytes)
      ) {
        existing.topPid = process.pid;
        existing.topExecutable = process.executable;
        existing.topCpuPercent = process.cpuPercent;
        existing.topRssBytes = process.rssBytes;
      }
      continue;
    }
    const classification = owner?.classification ?? 'unknown';
    groups.set(key, {
      rootPid: root.pid,
      processCount: 1,
      executable: root.executable,
      topPid: process.pid,
      topExecutable: process.executable,
      topCpuPercent: process.cpuPercent,
      topRssBytes: process.rssBytes,
      cpuPercent: 0,
      rssBytes: 0,
      classification,
      confidence: owner?.confidence ?? 'low',
      cleanupEligible: classification === 'stale',
      evidence: owner?.evidence ?? ['no-run-slot-resource-or-tmux-owner'],
      ...(owner?.slotId ? { slotId: owner.slotId } : {}),
      ...(owner?.runId ? { runId: owner.runId } : {}),
      ...(owner?.resourceId ? { resourceId: owner.resourceId } : {}),
      ...(owner?.tmuxTarget ? { tmuxTarget: owner.tmuxTarget } : {}),
      cpuRaw: process.cpuPercent,
      rssRaw: process.rssBytes,
    });
  }

  const allGroups = [...groups.values()]
    .map(({ cpuRaw, rssRaw, ...group }) => ({
      ...group,
      cpuPercent: Math.round(cpuRaw * 10) / 10,
      rssBytes: rssRaw,
    }))
    .sort(
      (a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes || a.rootPid - b.rootPid,
    );
  const classCounts = { ...EMPTY_CLASS_COUNTS };
  for (const group of allGroups) classCounts[group.classification] += 1;
  const maxGroups = params.maxGroups ?? MAX_ATTRIBUTION_GROUPS;
  const managed = allGroups
    .filter((group) => ['active', 'retained', 'stale'].includes(group.classification))
    .slice(0, Math.min(8, maxGroups));
  const visible = [
    ...allGroups
      .filter((group) => !managed.includes(group))
      .slice(0, Math.max(0, maxGroups - managed.length)),
    ...managed,
  ].sort((a, b) => allGroups.indexOf(a) - allGroups.indexOf(b));
  return {
    groups: visible,
    omittedGroups: Math.max(0, allGroups.length - maxGroups),
    classCounts,
  };
}
