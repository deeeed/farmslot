import { html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  MachineParkRecord,
  MachineParkResourceManifest,
  MachinePauseMode,
  MachinePausePreviewResult,
  MachinePauseRestoreParams,
  MachinePauseRestoreResult,
  MachinePauseSelector,
  MachinePauseStatusResult,
  ResourcePressureMachine,
} from '@farmslot/protocol';

import '../components/fleet-map/machine-pause-dialog.js';

const sampledAt = '2026-08-21T08:30:00.000Z';

const pressure: ResourcePressureMachine = {
  machine: 'macwork',
  online: true,
  headroom: 'red',
  severity: 'critical',
  concerns: [
    { severity: 'critical', reason: 'Sustained CPU and memory pressure.' },
    { severity: 'warn', reason: 'Load has remained above logical core capacity.' },
  ],
  history: [
    {
      collectedAt: sampledAt,
      pressure: { cpu: 0.88, memory: 0.84, disk: 0.61, load1: 1.32, load5: 1.14 },
      cpuPercent: 88,
      memoryPercent: 84,
      diskPercent: 61,
      loadAvg1: 13.2,
      loadAvg5: 11.4,
    },
  ],
  processAttribution: {
    sampledAt,
    truncated: true,
    ancestryTruncated: true,
    sampledProcesses: 192,
    totalProcesses: 192,
    maxEntries: 256,
    omittedGroups: 3,
    classCounts: { active: 2, retained: 1, stale: 1, manual: 0, unknown: 1 },
    managedGroupCount: 4,
    managedClassCounts: { active: 2, retained: 1, stale: 1, manual: 0, unknown: 0 },
    groups: [
      {
        rootPid: 4100,
        processCount: 9,
        executable: 'node',
        topPid: 4118,
        topExecutable: 'tsx',
        topCpuPercent: 184,
        topRssBytes: 1_288_490_188,
        cpuPercent: 236,
        rssBytes: 2_342_584_320,
        classification: 'active',
        confidence: 'high',
        evidence: ['run worker session'],
        runId: 'run-monitor-17',
        slotId: 'macwork-mm-2',
      },
      {
        rootPid: 5100,
        processCount: 4,
        executable: 'node',
        topPid: 5108,
        topExecutable: 'vite',
        topCpuPercent: 71,
        topRssBytes: 812_646_400,
        cpuPercent: 94,
        rssBytes: 1_021_313_024,
        classification: 'retained',
        confidence: 'high',
        evidence: ['resource pid'],
        runId: 'run-ci-29',
        resourceId: 'metro',
      },
      {
        rootPid: 6100,
        processCount: 2,
        executable: 'Google Chrome',
        topPid: 6102,
        topExecutable: 'Google Chrome Helper (Renderer)',
        topCpuPercent: 42,
        topRssBytes: 641_728_512,
        cpuPercent: 49,
        rssBytes: 801_112_064,
        classification: 'stale',
        confidence: 'medium',
        evidence: ['stale slot resource'],
        slotId: 'macwork-mme-1',
      },
      {
        rootPid: 7100,
        processCount: 3,
        executable: 'kernel_task',
        topPid: 7101,
        topExecutable: 'WindowServer',
        topCpuPercent: 28,
        topRssBytes: 388_284_416,
        cpuPercent: 36,
        rssBytes: 512_753_664,
        classification: 'unknown',
        confidence: 'low',
        evidence: ['no verified Farmslot owner'],
      },
    ],
    sampler: {
      attempts: 14,
      executions: 12,
      failures: 1,
      skippedBusy: 1,
      skippedCadence: 8,
      lastDurationMs: 84,
      lastError: 'Process inventory timed out once.',
    },
    degradedReason: 'Process attribution is using the last complete bounded sample.',
  },
  slots: { total: 6, ready: 2, busy: 3, working: 2, manual: 0, disabled: 1 },
  resources: {
    total: 9,
    byStatus: { unknown: 0, running: 6, stopped: 2, error: 0, stale: 1 },
    cleanupCandidates: 1,
  },
};

const monitorManifest: MachineParkResourceManifest = {
  capturedAt: sampledAt,
  resources: [
    {
      resourceId: 'metro',
      label: 'Metro',
      type: 'dev-server',
      observedStatus: 'running',
      phase: 'observed-running',
      capabilityLeaseIds: [],
    },
    {
      resourceId: 'ios-sim',
      label: 'iOS Simulator',
      type: 'device',
      observedStatus: 'running',
      phase: 'observed-running',
      capabilityLeaseIds: [],
    },
  ],
  capabilityLeases: [],
};

const parkedRecord: MachineParkRecord = {
  version: 1,
  operationId: 'park-op-17',
  previewId: 'pause-preview-dev',
  runId: 'run-ci-29',
  generation: 7,
  machine: 'macwork',
  slotId: 'macwork-mme-1',
  mode: 'release',
  phase: 'parked',
  prePauseStatus: 'ci-watching',
  prePauseCurrentStep: { index: 8, name: 'ci-watch', status: 'running' },
  resourceManifest: monitorManifest,
  recoveryHandle: {
    version: 1,
    runnerId: 'codex',
    contextId: 'context-ci-29',
    sessionId: 'session-ci-29',
    sessionPath: '/tmp/farmslot/sessions/session-ci-29.json',
    target: {
      session: 'farmslot-ci-29',
      window: '0',
      pane: '0',
      paneId: '%29',
      target: 'farmslot-ci-29:0.0',
    },
    model: 'gpt-5.5',
    capturedAt: sampledAt,
  },
  errors: [],
  residuals: {
    runner: 'stopped',
    resources: [
      { resourceId: 'metro', state: 'stopped' },
      { resourceId: 'ios-sim', state: 'stopped' },
    ],
  },
  createdAt: '2026-08-21T08:20:00.000Z',
  updatedAt: '2026-08-21T08:22:00.000Z',
  parkedAt: '2026-08-21T08:22:00.000Z',
};

const partialRecord: MachineParkRecord = {
  ...parkedRecord,
  operationId: 'park-op-18',
  runId: 'run-monitor-18',
  generation: 3,
  slotId: 'macwork-mm-3',
  phase: 'partial',
  errors: [
    {
      phase: 'resources-stopping',
      action: 'shutdown Metro',
      code: 'resource-hook-failed',
      message: 'Project shutdown hook exited 1.',
      occurredAt: '2026-08-21T08:24:00.000Z',
      retryable: true,
      resourceId: 'metro',
    },
  ],
  residuals: {
    runner: 'stopped',
    resources: [
      { resourceId: 'metro', state: 'running', detail: 'shutdown hook failed' },
      { resourceId: 'ios-sim', state: 'stopped' },
    ],
  },
  updatedAt: '2026-08-21T08:24:00.000Z',
};

function selectorIncludes(selector: MachinePauseSelector, runId: string): boolean {
  if (selector.kind === 'all') return true;
  if (selector.kind === 'include') return selector.runIds.includes(runId);
  return !selector.runIds.includes(runId);
}

function selectorKey(selector: MachinePauseSelector): string {
  return selector.kind === 'all'
    ? 'all'
    : `${selector.kind}-${selector.runIds.join('-') || 'none'}`;
}

function pausePreview(
  mode: MachinePauseMode,
  selector: MachinePauseSelector,
): MachinePausePreviewResult {
  return {
    previewId: `pause-preview-${mode}-${selectorKey(selector)}`,
    machine: 'macwork',
    mode,
    selector,
    createdAt: sampledAt,
    eligibleCount: 2,
    rejectedCount: 1,
    pressure,
    runs: [
      {
        runId: 'run-monitor-17',
        generation: 12,
        selected: selectorIncludes(selector, 'run-monitor-17'),
        slotId: 'macwork-mm-2',
        status: 'monitoring',
        currentStep: { index: 6, name: 'monitor', status: 'running' },
        slotDisposition: 'retained',
        eligibility: {
          eligible: true,
          code: 'eligible-monitoring',
          reason: 'Monitoring is safe to park at its current checkpoint.',
        },
        recoveryPolicy:
          mode === 'release'
            ? { kind: 'runner-session-reload', supported: true, runnerId: 'codex' }
            : { kind: 'orchestration-only', supported: true },
        resourceManifest: monitorManifest,
      },
      {
        runId: 'run-ci-31',
        generation: 5,
        selected: selectorIncludes(selector, 'run-ci-31'),
        slotId: 'macwork-mme-2',
        status: 'ci-watching',
        currentStep: { index: 8, name: 'ci-watch', status: 'running' },
        slotDisposition: 'retained',
        eligibility: {
          eligible: true,
          code: 'eligible-ci-watching',
          reason: 'CI watching is safe to park and resume.',
        },
        recoveryPolicy:
          mode === 'release'
            ? { kind: 'runner-session-reload', supported: true, runnerId: 'claude' }
            : { kind: 'orchestration-only', supported: true },
        resourceManifest: { capturedAt: sampledAt, resources: [], capabilityLeases: [] },
      },
      {
        runId: 'run-dispatch-4',
        generation: 2,
        selected: selectorIncludes(selector, 'run-dispatch-4'),
        slotId: 'macwork-mm-4',
        status: 'dispatching',
        currentStep: { index: 3, name: 'dispatch', status: 'running' },
        slotDisposition: 'retained',
        eligibility: {
          eligible: false,
          code: 'status-not-pausable',
          reason: 'Dispatch is non-idempotent and cannot be machine-paused.',
        },
        recoveryPolicy: { kind: 'orchestration-only', supported: true },
        resourceManifest: { capturedAt: sampledAt, resources: [], capabilityLeases: [] },
      },
    ],
  };
}

const status: MachinePauseStatusResult = {
  machine: 'macwork',
  records: [parkedRecord, partialRecord],
  pressure,
};

function restorePreview(selector: MachinePauseSelector): MachinePauseRestoreResult {
  return {
    ok: true,
    outcome: 'preview',
    execute: false,
    previewId: `restore-preview-${selectorKey(selector)}`,
    machine: 'macwork',
    selector,
    records: [parkedRecord, partialRecord],
    pressure,
    runs: [
      {
        runId: parkedRecord.runId,
        generation: parkedRecord.generation,
        selected: selectorIncludes(selector, parkedRecord.runId),
        eligibility: {
          eligible: true,
          code: 'parked-restorable',
          reason: 'Durable recovery handle and resource manifest are available.',
        },
        restoreTarget: {
          slotId: parkedRecord.slotId,
          disposition: parkedRecord.slotDisposition ?? 'retained',
          available: true,
        },
        record: parkedRecord,
      },
      {
        runId: partialRecord.runId,
        generation: partialRecord.generation,
        selected: selectorIncludes(selector, partialRecord.runId),
        eligibility: {
          eligible: true,
          code: 'partial-retry-restorable',
          reason: 'The durable partial record can retry restore from its saved checkpoint.',
        },
        restoreTarget: {
          slotId: partialRecord.slotId,
          disposition: partialRecord.slotDisposition ?? 'retained',
          available: true,
        },
        record: partialRecord,
      },
    ],
  };
}

@customElement('machine-pause-dev')
export class MachinePauseDev extends LitElement {
  @state() private mode: MachinePauseMode = 'release';
  @state() private pauseSelector: MachinePauseSelector = {
    kind: 'include',
    runIds: ['run-monitor-17', 'run-ci-31'],
  };
  @state() private restoreSelector: MachinePauseSelector = { kind: 'all' };

  protected override createRenderRoot() {
    return this;
  }

  override render() {
    return html`<machine-pause-dialog
      .open=${true}
      .machine=${'macwork'}
      .mode=${this.mode}
      .preview=${pausePreview(this.mode, this.pauseSelector)}
      .status=${status}
      .restorePreview=${restorePreview(this.restoreSelector)}
      @machine-pause-mode-change=${(event: CustomEvent<{ mode: MachinePauseMode }>) => {
        this.mode = event.detail.mode;
      }}
      @machine-pause-selection-change=${(
        event: CustomEvent<{ scope: 'pause' | 'restore'; selector: MachinePauseSelector }>,
      ) => {
        if (event.detail.scope === 'pause') this.pauseSelector = event.detail.selector;
        else this.restoreSelector = event.detail.selector;
      }}
      @machine-pause-restore=${(
        event: CustomEvent<Extract<MachinePauseRestoreParams, { execute: true }>>,
      ) => {
        this.restoreSelector =
          event.detail.selector.kind === 'all'
            ? { kind: 'exclude', runIds: [partialRecord.runId] }
            : { kind: 'all' };
      }}
    ></machine-pause-dialog>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'machine-pause-dev': MachinePauseDev;
  }
}
