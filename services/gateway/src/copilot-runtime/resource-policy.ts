import os from 'node:os';

import type {
  ActiveResourcePointer,
  CopilotHostWorkload,
  CopilotWorkloadSnapshot,
  CopilotWorkloadTotals,
  FleetStatus,
  Run,
} from '@farmslot/protocol';

const ACTIVE_AGENT_STATES = new Set(['launching', 'working', 'waiting']);
const ACTIVE_RUN_STATES = new Set([
  'grading',
  'writing-task',
  'slot-finding',
  'preparing',
  'dispatching',
  'monitoring',
  'self-reviewing',
  'completing',
  'ci-watching',
]);

export interface WorkloadResourceInput {
  slotId: string;
  resourceId: string;
  pointer: ActiveResourcePointer;
}

function emptyTotals(): CopilotWorkloadTotals {
  return {
    implementation: 0,
    independentReview: 0,
    reviewRework: 0,
    ciFix: 0,
    fullQa: 0,
    recipe: 0,
    prepare: 0,
    devServer: 0,
    copilot: 0,
    total: 0,
  };
}

function roleBucket(role: string, flowType: string): keyof CopilotWorkloadTotals {
  if (role === 'ci-fix') return 'ciFix';
  if (role === 'self-review' || role === 'self-review-fix') return 'reviewRework';
  if (role === 'review' || flowType === 'review-pr') return 'independentReview';
  return 'implementation';
}

function increment(
  byHost: Map<string, CopilotWorkloadTotals>,
  host: string,
  bucket: keyof CopilotWorkloadTotals,
): void {
  const totals = byHost.get(host) ?? emptyTotals();
  totals[bucket] += 1;
  byHost.set(host, totals);
}

export function buildCopilotWorkloadSnapshot(input: {
  runs: readonly Run[];
  fleet: FleetStatus | null;
  resources?: readonly WorkloadResourceInput[];
  copilotRunning: boolean;
  localHost?: string;
  highPressureThreshold?: number;
}): CopilotWorkloadSnapshot {
  const localHost = input.localHost ?? os.hostname().replace(/\.local$/, '');
  const slotHost = new Map((input.fleet?.slots ?? []).map((slot) => [slot.slot, slot.machine]));
  const byHost = new Map<string, CopilotWorkloadTotals>();

  for (const run of input.runs) {
    if (!ACTIVE_RUN_STATES.has(run.status)) continue;
    const host = (run.slotId && slotHost.get(run.slotId)) || localHost;
    const contexts = (run.agentContexts ?? []).filter((context) =>
      ACTIVE_AGENT_STATES.has(context.status),
    );
    if (contexts.length === 0) {
      increment(byHost, host, roleBucket('primary', run.flowType));
    } else {
      for (const context of contexts) {
        increment(
          byHost,
          slotHost.get(context.slotId) ?? host,
          roleBucket(context.role, run.flowType),
        );
      }
    }
    if (
      run.flowType === 'review-pr' &&
      (run.reviewValidationDepth === 'full-live' || run.reviewTier === 'full')
    ) {
      increment(byHost, host, 'fullQa');
    }
    for (const step of run.steps.filter((candidate) => candidate.status === 'running')) {
      const name = step.name.toLowerCase();
      if (name.includes('recipe')) increment(byHost, host, 'recipe');
      if (name.includes('prepare')) increment(byHost, host, 'prepare');
    }
  }

  for (const resource of input.resources ?? []) {
    const id = resource.resourceId.toLowerCase();
    const host = slotHost.get(resource.slotId) ?? localHost;
    if (id.includes('dev-server') || id.includes('vite') || id.includes('metro')) {
      increment(byHost, host, 'devServer');
    }
  }
  if (input.copilotRunning) increment(byHost, localHost, 'copilot');

  const hosts: CopilotHostWorkload[] = [...byHost.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([host, counts]) => ({ ...counts, host }));
  const totals = emptyTotals();
  for (const host of hosts) {
    for (const bucket of Object.keys(totals) as Array<keyof CopilotWorkloadTotals>) {
      if (bucket !== 'total') totals[bucket] += host[bucket];
    }
  }
  totals.total =
    totals.implementation +
    totals.independentReview +
    totals.reviewRework +
    totals.ciFix +
    totals.fullQa +
    totals.recipe +
    totals.prepare +
    totals.devServer +
    totals.copilot;
  for (const host of hosts) {
    host.total =
      host.implementation +
      host.independentReview +
      host.reviewRework +
      host.ciFix +
      host.fullQa +
      host.recipe +
      host.prepare +
      host.devServer +
      host.copilot;
  }
  const severity = totals.total >= (input.highPressureThreshold ?? 8) ? 'high' : 'normal';
  return {
    severity,
    ...(severity === 'high'
      ? {
          warning: `${totals.total} concurrent implementation/review/QA/recipe/prepare/dev-server activities are attributed across hosts. Consider serialization.`,
        }
      : {}),
    totals,
    hosts,
    policy: {
      singleton: true,
      automaticCancellation: false,
      automaticDispatch: false,
      automaticFanOut: false,
    },
  };
}
