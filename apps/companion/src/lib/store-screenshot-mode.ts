import {
  type FleetStatus,
  Methods,
  type PendingDecision,
  type PRStatus,
  type Run,
  type SlotStatus,
  type TmuxWorkerNodeResult,
} from '@farmslot/protocol';

import { useConnectionStore } from '../store/connection';
import { useDecisionStore } from '../store/decisions';
import { useFilterStore } from '../store/filters';
import { useFleetStore } from '../store/fleet';
import { usePRStore } from '../store/prs';
import { useRunStore } from '../store/runs';

import { GatewayClient } from './gateway-client';
import type { GatewayProfile } from './gateway-profiles';

export const isStoreScreenshotMode = process.env.EXPO_PUBLIC_STORE_SCREENSHOTS === '1';

/**
 * Quiet capture / recipe mode: keep the real gateway connection, but do not
 * show first-run product chrome (What's New, App Updates, notification permission
 * prompt). Set via EXPO_PUBLIC_UX_CAPTURE=1 or EXPO_PUBLIC_STORE_SCREENSHOTS=1.
 */
export const suppressFirstRunOverlays =
  isStoreScreenshotMode || process.env.EXPO_PUBLIC_UX_CAPTURE === '1';

const DEMO_PROFILE: GatewayProfile = {
  id: 'store-demo-gateway',
  name: 'Demo Gateway',
  url: 'wss://paired-gateway.example/ws',
  kind: 'remote',
  authMode: 'none',
  readonly: true,
};

let seeded = false;

export function seedStoreScreenshotMode(): void {
  if (!isStoreScreenshotMode || seeded) return;
  seeded = true;

  const fixtures = createStoreScreenshotFixtures();
  useFleetStore.getState().setFleet(fixtures.fleet);
  useRunStore.getState().setRuns(fixtures.runs);
  useDecisionStore.getState().setDecisions(fixtures.decisions);
  usePRStore.getState().setPRs(fixtures.prs);
  useFilterStore.getState().clearAll();
  useFilterStore.getState().setAvailable(fixtures.fleet.slots);
  useConnectionStore.setState({
    status: 'connected',
    healthStatus: 'healthy',
    gatewayUrl: DEMO_PROFILE.url,
    profiles: [DEMO_PROFILE],
    activeProfileId: DEMO_PROFILE.id,
    activeProfileAuthMode: 'none',
    activeProfileHttpAuthHeaders: {},
    client: createScreenshotGatewayClient(fixtures),
    lastConnectedAt: Date.now(),
    lastSuccessfulProbeAt: Date.now(),
    lastProbeLatencyMs: 0,
    lastProbeError: null,
    consecutiveProbeFailures: 0,
    lastSyncError: null,
  });
}

function createScreenshotGatewayClient(fixtures: StoreScreenshotFixtures): GatewayClient {
  const client = new GatewayClient('');
  client.request = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
    let payload: unknown;
    switch (method) {
      case Methods.FLEET_STATUS:
        payload = { fleet: fixtures.fleet };
        break;
      case Methods.RUN_LIST:
        payload = { runs: fixtures.runs };
        break;
      case Methods.RUN_GET: {
        const runId = requestStringParam(params, 'id');
        const run = fixtures.runs.find((candidate) => candidate.id === runId) ?? fixtures.runs[0];
        payload = { run };
        break;
      }
      case Methods.RUN_FOR_SLOT: {
        const slotId = requestStringParam(params, 'slotId');
        const run = fixtures.runs.find((candidate) => candidate.slotId === slotId) ?? null;
        payload = { run };
        break;
      }
      case Methods.DECISION_LIST:
        payload = { decisions: fixtures.decisions };
        break;
      case Methods.PR_LIST:
        payload = { prs: fixtures.prs };
        break;
      case Methods.TMUX_WORKER_LIST:
        payload = {
          observedAt: Date.now(),
          nodes: fixtures.workerNodes,
          workers: fixtures.workers,
        };
        break;
      case Methods.TERMINAL_SNAPSHOT:
      case Methods.TERMINAL_WORKER_SNAPSHOT:
        payload = terminalSnapshot();
        break;
      case Methods.CHAT_HISTORY:
        payload = { messages: fixtures.chatMessages };
        break;
      default:
        throw new Error(`Store screenshot mode has no fixture for gateway method ${method}.`);
    }
    return payload as T;
  };
  client.subscribe = () => () => {};
  client.onConnectionChange = () => () => {};
  client.connect = () => undefined;
  client.disconnect = () => undefined;
  client.setConnection = () => undefined;
  return client;
}

function requestStringParam(params: unknown, key: string): string | null {
  if (!params || typeof params !== 'object') return null;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

interface StoreScreenshotFixtures {
  fleet: FleetStatus;
  runs: Run[];
  decisions: PendingDecision[];
  prs: PRStatus[];
  workerNodes: TmuxWorkerNodeResult[];
  workers: TmuxWorkerNodeResult['workers'];
  chatMessages: unknown[];
}

function createStoreScreenshotFixtures(): StoreScreenshotFixtures {
  const now = new Date();
  const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const slots: SlotStatus[] = [
    slot({
      slot: 'runner-mobile-1',
      machine: 'runner-local',
      project: 'example-mobile',
      lifecycle: 'busy',
      phase: 'working',
      currentRunId: 'run-recipe-ui',
      currentFlowType: 'fix-bug',
      currentTicketOrPr: 'Recipe harness polish',
      branch: 'fix/recipe-harness-ui',
      taskPhase: 'Validate 5/7',
      progress: 0.71,
      runner: 'codex',
      model: 'gpt-5.4',
      deviceName: 'Pixel 6',
    }),
    slot({
      slot: 'runner-b-web-2',
      machine: 'runner-b',
      project: 'farmslot-farm',
      lifecycle: 'held',
      phase: 'ci-watch',
      currentRunId: 'run-docs-release',
      currentFlowType: 'review-pr',
      currentTicketOrPr: 'Recipe protocol docs',
      branch: 'docs/recipe-v1',
      taskPhase: 'CI watch',
      progress: 0.92,
      runner: 'claude',
      model: 'sonnet',
      deviceName: 'Chrome',
    }),
    slot({
      slot: 'runner-a-exp-1',
      machine: 'runner-a',
      project: 'example-audio',
      lifecycle: 'busy',
      phase: 'working',
      currentRunId: 'run-audio-beta',
      currentFlowType: 'dev',
      currentTicketOrPr: 'offline audio runtime beta upgrade',
      branch: 'feat/audio-runtime-beta',
      taskPhase: 'Validate 6/7',
      progress: 0.84,
      runner: 'codex',
      model: 'gpt-5.4',
      deviceName: 'iPhone 17',
    }),
    slot({
      slot: 'runner-local-fs-3',
      machine: 'runner-local',
      project: 'farmslot-farm',
      lifecycle: 'ready',
      phase: null,
      currentRunId: null,
      currentFlowType: null,
      currentTicketOrPr: 'Ready for dispatch',
      branch: 'main',
      taskPhase: null,
      progress: null,
      runner: null,
      model: null,
      deviceName: 'iPad Pro',
    }),
  ];
  const fleet: FleetStatus = {
    checkedAt: iso(0),
    slots,
    summary: {
      total: 4,
      ready: 1,
      busy: 2,
      held: 1,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 1,
    },
  };
  const runs: Run[] = [
    run({
      id: 'run-recipe-ui',
      familyId: 'family-recipe-ui',
      flowType: 'fix-bug',
      lane: 'production',
      status: 'monitoring',
      project: 'example-mobile',
      ticketOrPr: 'Recipe UI demo',
      slotId: 'runner-mobile-1',
      branch: 'fix/recipe-harness-ui',
      summary: 'Prove recipe harness output renders correctly on mobile.',
      createdAt: iso(58),
      updatedAt: iso(3),
      prNumber: 4321,
    }),
    run({
      id: 'run-docs-release',
      familyId: 'family-docs-release',
      flowType: 'review-pr',
      lane: 'validation',
      status: 'human-gating',
      project: 'farmslot-farm',
      ticketOrPr: 'Docs review',
      slotId: 'runner-b-web-2',
      branch: 'docs/recipe-v1',
      summary: 'Review recipe protocol docs and generated gateway reference.',
      createdAt: iso(140),
      updatedAt: iso(11),
      prNumber: 117,
    }),
    run({
      id: 'run-audio-beta',
      familyId: 'family-audio-beta',
      flowType: 'dev',
      lane: 'production',
      status: 'monitoring',
      project: 'example-audio',
      ticketOrPr: 'audio runtime beta',
      slotId: 'runner-a-exp-1',
      branch: 'feat/audio-runtime-beta',
      summary: 'Align offline audio runtime packages across apps.',
      createdAt: iso(360),
      updatedAt: iso(44),
    }),
  ];
  const decisions: PendingDecision[] = [
    {
      id: 'decision-review-docs',
      type: 'review_posting',
      slotId: 'runner-b-web-2',
      title: 'Review evidence before publishing package',
      description:
        'The worker finished validation. Check the diff, screenshots, and command log before approving the publish step.',
      context: { runId: 'run-docs-release', familyId: 'family-docs-release' },
      actions: [
        { id: 'approve', label: 'Approve', style: 'primary' },
        { id: 'request-fix', label: 'Request fixes', style: 'secondary' },
      ],
      createdAt: iso(9),
      runMeta: {
        runId: 'run-docs-release',
        familyId: 'family-docs-release',
        flowType: 'review-pr',
        ticketOrPr: 'Docs review',
        prNumber: 117,
        branch: 'docs/recipe-v1',
        runner: 'claude',
        model: 'sonnet',
        summary: 'Recipe protocol documentation review.',
      },
    },
  ];
  const prs: PRStatus[] = [
    pr({
      pr: 117,
      title: 'Formalize recipe v1 harness protocol and docs',
      repo: 'farmslot/farmslot',
      project: 'farmslot-farm',
      recommendation: 'READY',
      slot: 'runner-b-web-2',
      passed: 18,
      failed: 0,
      pending: 1,
      familyId: 'family-docs-release',
      latestRunId: 'run-docs-release',
    }),
    pr({
      pr: 4321,
      title: 'Fix recipe harness evidence panel on mobile',
      repo: 'example-app/example-mobile',
      project: 'example-mobile',
      recommendation: 'NEEDS_ATTENTION',
      slot: 'runner-mobile-1',
      passed: 21,
      failed: 1,
      pending: 3,
      familyId: 'family-recipe-ui',
      latestRunId: 'run-recipe-ui',
      actionableBotComments: 2,
    }),
    pr({
      pr: 88,
      title: 'Upgrade React Native audio runtime packages',
      repo: 'example-org/example-audio',
      project: 'example-audio',
      recommendation: 'IN_REVIEW',
      slot: 'runner-a-exp-1',
      passed: 12,
      failed: 0,
      pending: 2,
      familyId: 'family-audio-beta',
      latestRunId: 'run-audio-beta',
    }),
  ];
  const workerNodes: TmuxWorkerNodeResult[] = [
    {
      nodeId: 'runner-local',
      connected: true,
      ok: true,
      observedAt: Date.now(),
      summary: { panes: 1, active: 1, waiting: 0, idle: 0, stale: 0, unknown: 0 },
      workers: [
        worker(
          'runner-local',
          'fs-companion',
          '0',
          'codex',
          'runner-mobile-1',
          'run-recipe-ui',
          'active',
        ),
      ],
    },
    {
      nodeId: 'runner-b',
      connected: true,
      ok: true,
      observedAt: Date.now(),
      summary: { panes: 1, active: 0, waiting: 1, idle: 0, stale: 0, unknown: 0 },
      workers: [
        worker(
          'runner-b',
          'fs-companion',
          '0',
          'claude',
          'runner-b-web-2',
          'run-docs-release',
          'waiting',
        ),
      ],
    },
    {
      nodeId: 'runner-a',
      connected: true,
      ok: true,
      observedAt: Date.now(),
      summary: { panes: 1, active: 0, waiting: 0, idle: 1, stale: 0, unknown: 0 },
      workers: [
        worker(
          'runner-a',
          'example-audio',
          '0',
          'codex',
          'runner-a-exp-1',
          'run-audio-beta',
          'idle',
        ),
      ],
    },
  ];
  const workers = workerNodes.flatMap((node) => node.workers);
  return { fleet, runs, decisions, prs, workerNodes, workers, chatMessages: [] };
}

function slot(input: {
  slot: string;
  machine: string;
  project: string;
  lifecycle: SlotStatus['lifecycle'];
  phase: SlotStatus['phase'];
  currentRunId: string | null;
  currentFlowType: string | null;
  currentTicketOrPr: string;
  branch: string;
  taskPhase: string | null;
  progress: number | null;
  runner: string | null;
  model: string | null;
  deviceName: string;
}): SlotStatus {
  return {
    slot: input.slot,
    machine: input.machine,
    platform: input.deviceName === 'Chrome' ? 'web' : 'mobile',
    project: input.project,
    health: { ssh: 'OK', device: 'OK', devserver: 'OK', cdp: 'OK', fixtures: 'OK' },
    branch: input.branch,
    agent: input.lifecycle === 'busy' ? 'working' : 'idle',
    enabled: true,
    dispatchable: input.lifecycle === 'ready',
    lifecycle: input.lifecycle,
    phase: input.phase,
    warm: input.lifecycle === 'ready',
    taskId: input.currentRunId,
    taskFile: input.currentRunId ? 'TASK.md' : null,
    currentRunId: input.currentRunId,
    currentFlowType: input.currentFlowType,
    currentTicketOrPr: input.currentTicketOrPr,
    dispatchedAt: input.currentRunId ? new Date(Date.now() - 25 * 60_000).toISOString() : null,
    completedAt: null,
    runner: input.runner,
    model: input.model,
    resources: {},
    deviceName: input.deviceName,
    taskPhase: input.taskPhase,
    taskStepProgress: input.progress,
  };
}

function run(
  input: Partial<Run> &
    Pick<
      Run,
      | 'id'
      | 'familyId'
      | 'flowType'
      | 'lane'
      | 'status'
      | 'project'
      | 'ticketOrPr'
      | 'slotId'
      | 'branch'
      | 'createdAt'
      | 'updatedAt'
    >,
): Run {
  return {
    id: input.id,
    familyId: input.familyId,
    lane: input.lane,
    flowType: input.flowType,
    status: input.status,
    project: input.project,
    ticketOrPr: input.ticketOrPr,
    slotId: input.slotId,
    branch: input.branch,
    taskFile: 'TASK.md',
    activeTaskFile: 'TASK.md',
    steps: [
      { name: 'Prepare slot', status: 'done', durationMs: 42_000 },
      { name: 'Run worker', status: input.status === 'done' ? 'done' : 'running' },
      { name: 'Validate evidence', status: input.status === 'done' ? 'done' : 'pending' },
    ],
    decisions: [],
    metrics: {
      durationMs: 38 * 60_000,
      nudgeCount: 0,
      model: input.flowType === 'review-pr' ? 'sonnet' : 'gpt-5.4',
      runner: input.flowType === 'review-pr' ? 'claude' : 'codex',
      tokensIn: 18400,
      tokensOut: 3400,
      costUsd: 2.14,
    } as Run['metrics'],
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt,
    prNumber: input.prNumber,
    summary: input.summary,
  };
}

function pr(input: {
  pr: number;
  title: string;
  repo: string;
  project: string;
  recommendation: PRStatus['recommendation'];
  slot: string;
  passed: number;
  failed: number;
  pending: number;
  familyId: string;
  latestRunId: string;
  actionableBotComments?: number;
}): PRStatus {
  const total = input.passed + input.failed + input.pending;
  const actionableBotComments = Array.from(
    { length: input.actionableBotComments ?? 0 },
    (_, index) => ({
      author: 'github-actions',
      label: `bot-${index + 1}`,
      action: 'address',
      bodyPreview: 'Validator found an actionable follow-up.',
      createdAt: new Date().toISOString(),
      source: 'bot',
      workerResponded: false,
    }),
  );
  return {
    pr: input.pr,
    title: input.title,
    summary: 'Tracked by Farmslot with validation evidence and worker context.',
    repo: input.repo,
    headRef: `store-demo-${input.pr}`,
    project: input.project,
    slot: input.slot,
    session: 'fs-companion',
    checks: [],
    checkSummary: {
      passed: input.passed,
      failed: input.failed,
      pending: input.pending,
      skipped: 0,
      total,
    },
    allCheckSummary: {
      passed: input.passed,
      failed: input.failed,
      pending: input.pending,
      skipped: 0,
      total,
    },
    allPassed: input.failed === 0 && input.pending === 0,
    anyFailed: input.failed > 0,
    failedNames: input.failed > 0 ? ['mobile-e2e'] : [],
    botComments: actionableBotComments,
    actionableBotComments,
    prState: 'OPEN',
    createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    closedAt: null,
    mergedAt: null,
    merged: false,
    mergeable: input.failed > 0 ? 'CONFLICTING' : 'MERGEABLE',
    mergeConflict: false,
    reviewDecision: input.recommendation === 'READY' ? 'approved' : 'pending',
    recommendation: input.recommendation,
    ownedFamily: true,
    familyId: input.familyId,
    familyRootTicketOrPr: `#${input.pr}`,
    familyRunCount: 2,
    activeFamilyRunCount: input.recommendation === 'READY' ? 0 : 1,
    workflowState: input.recommendation === 'READY' ? 'complete' : 'active',
    mergeState: input.recommendation === 'READY' ? 'waiting_for_merge' : 'not_applicable',
    latestRunId: input.latestRunId,
  };
}

function worker(
  nodeId: string,
  session: string,
  pane: string,
  command: string,
  slotId: string,
  runId: string,
  state: 'active' | 'waiting' | 'idle',
): TmuxWorkerNodeResult['workers'][number] {
  return {
    ref: { nodeId, session, window: '0', windowName: 'main', pane, target: `${session}:0.${pane}` },
    title: `${command} worker`,
    cwd: `/Users/example/dev/${slotId}`,
    command,
    active: state === 'active',
    linkedSlotId: slotId,
    linkedRunId: runId,
    branch: 'store-demo',
    lastChangedAt: Date.now() - 4 * 60_000,
    status: {
      label: state,
      source: 'statusline',
      confidence: 'high',
      state,
      observedAt: Date.now(),
    },
  };
}

function terminalSnapshot() {
  return {
    mode: 'terminal',
    lines: [
      '$ farmslot run --recipe validate-mobile',
      '✓ loaded fixture profile',
      '✓ launched target app',
      '✓ captured evidence screenshot',
      '→ waiting for operator approval',
    ],
    cursor: { x: 2, y: 4 },
    cwd: '/Users/example/dev/farmslot',
  };
}
