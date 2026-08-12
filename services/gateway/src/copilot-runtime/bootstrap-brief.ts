import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type CopilotCheckoutIdentity,
  type CopilotWorkloadSnapshot,
  GLOBAL_CHAT_SESSION_ID,
  type OperatorSnapshotResult,
  type Run,
} from '@farmslot/protocol';

import { listItems } from '../backlog/dispatch-queue.js';
import { loadMemory } from '../chat/chat-memory.js';
import { readObserverEvidence } from '../chat/copilot-observer.js';
import { readLastScreenEvidence } from '../chat/screen-evidence.js';
import { getActiveResources } from '../fleet/resource-manager.js';
import { getCachedFleet } from '../fleet/state.js';
import { operatorSnapshot } from '../methods/operator.js';
import { getAllRuns } from '../runs/store.js';

import { redactCopilotValue } from './session-store.js';

export interface CopilotBootstrapInput {
  generatedAt: string;
  runtime: { runner: string; model: string; safetyTier: string; tmuxTarget: string };
  checkout: CopilotCheckoutIdentity;
  operator: OperatorSnapshotResult;
  screenEvidence: unknown;
  observerEvidence: unknown;
  savedMemory: string;
  runs: readonly Run[];
  workload: CopilotWorkloadSnapshot;
  backlog: unknown;
  roadmap: string;
  cadence: Record<string, unknown>;
}

function section(title: string, value: unknown): string {
  const redacted = redactCopilotValue(value);
  return `## ${title}\n${typeof redacted === 'string' ? redacted : JSON.stringify(redacted, null, 2)}`;
}

export function buildCopilotBootstrapBrief(input: CopilotBootstrapInput): string {
  const roleInventory = input.runs.flatMap((run) =>
    (run.agentContexts ?? []).map((context) => ({
      runId: run.id,
      flowType: run.flowType,
      reviewValidationDepth: run.reviewValidationDepth,
      role: context.role,
      status: context.status,
      hostSlot: context.slotId,
      target: context.target?.target,
      runner: context.runner,
      model: context.model,
    })),
  );
  const prReviewState = input.runs
    .filter((run) => run.prNumber || run.flowType === 'review-pr')
    .map((run) => ({
      runId: run.id,
      flowType: run.flowType,
      prNumber: run.prNumber,
      prState: run.prState,
      reviewScope: run.reviewScope,
      reviewValidationDepth: run.reviewValidationDepth,
      publishGate: run.engineState?.publishGate,
    }));
  const recipeActivity = input.runs.flatMap((run) =>
    run.steps
      .filter((step) => step.name.toLowerCase().includes('recipe'))
      .map((step) => ({ runId: run.id, flowType: run.flowType, ...step })),
  );
  const prepareActivity = input.runs.flatMap((run) =>
    run.steps
      .filter((step) => step.name.toLowerCase().includes('prepare'))
      .map((step) => ({ runId: run.id, flowType: run.flowType, ...step })),
  );

  return [
    '# Gateway Co-Pilot Agent Runtime Bootstrap',
    `Generated deterministically at ${input.generatedAt}. This is context, not authorization.`,
    section('Runtime identity', input.runtime),
    section('Authority rules', {
      defaultTier: 'sandboxed',
      dangerousContainment: 'same-user dangerous access is audited governance, not hard containment',
      forbiddenImplicitActions: [
        'gate approval',
        'publication',
        'merge',
        'release',
        'deletion',
        'cancellation',
        'backlog dispatch',
        'dispatch expansion',
        'subagent fan-out',
      ],
      structuredProductActions: 'Use explicit existing Gateway methods and confirmation flows only.',
      authorityDependency: 'ADR-051 and its containment follow-up.',
    }),
    section('Checkout state', input.checkout),
    section('Current Command Center screen evidence', input.screenEvidence ?? 'No screen evidence.'),
    section('Observer evidence', input.observerEvidence),
    section('Saved Co-Pilot memory', input.savedMemory || 'No saved memory.'),
    section('Operator snapshot', input.operator),
    section('Full agent-role inventory', roleInventory),
    section('Fleet and host workload pressure', input.workload),
    section('Pending decisions', input.operator.pendingDecisions),
    section('Backlog and dispatch queue', input.backlog),
    section('Roadmap', input.roadmap),
    section('PR and independent-review state', prReviewState),
    section('Recipe executions', recipeActivity),
    section('Prepare and dev-server activity', {
      prepare: prepareActivity,
      devServerTotals: input.workload.hosts.map((host) => ({
        host: host.host,
        devServer: host.devServer,
      })),
    }),
    section('Watch cadence', input.cadence),
  ].join('\n\n');
}

export async function buildLiveCopilotBootstrapBrief(input: {
  runtime: CopilotBootstrapInput['runtime'];
  checkout: CopilotCheckoutIdentity;
  workload: CopilotWorkloadSnapshot;
  transcriptId?: string;
}): Promise<string> {
  const [operator, savedMemory, roadmap] = await Promise.all([
    operatorSnapshot(),
    loadMemory(),
    readFile(path.join(input.checkout.path, 'docs/ROADMAP-next.md'), 'utf8'),
  ]);
  const fleet = getCachedFleet();
  const devServers = (fleet?.slots ?? []).flatMap((slot) =>
    [...(getActiveResources(slot.slot)?.entries() ?? [])]
      .filter(([resourceId]) => /dev-server|vite|metro/i.test(resourceId))
      .map(([resourceId, pointer]) => ({ slotId: slot.slot, resourceId, ...pointer })),
  );
  return buildCopilotBootstrapBrief({
    generatedAt: new Date().toISOString(),
    runtime: input.runtime,
    checkout: input.checkout,
    operator,
    screenEvidence: readLastScreenEvidence(input.transcriptId ?? GLOBAL_CHAT_SESSION_ID),
    observerEvidence: readObserverEvidence({ limit: 40 }),
    savedMemory,
    runs: getAllRuns(),
    workload: input.workload,
    backlog: { queue: listItems() },
    roadmap: roadmap.slice(0, 40_000),
    cadence: {
      resourcePoll: 'gateway configured interval',
      tmuxTranscriptPollMs: 750,
      operatorRefresh: 'client controlled',
      activeDevServers: devServers,
    },
  });
}
