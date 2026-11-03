import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

import { html, nothing } from 'lit';

import type {
  AcceptanceStatusLedger,
  AgentContext,
  ArtifactRef,
  FileTransferProgress,
  Run,
  RunDecision,
  RunStep,
} from '@farmslot/protocol';

import type { FileTransferUiEntry } from '../shared/file-transfer-progress-model.js';

let transferProgressListener: ((value: FileTransferProgress) => void) | undefined;
// The renderers reach the browser gateway client at import time.
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      request: async () => ({}),
      subscribe: (_event: string, listener: (value: FileTransferProgress) => void) => {
        transferProgressListener = listener;
        return () => {
          transferProgressListener = undefined;
        };
      },
    },
  },
});
// The browser-only review history panel is not under test.
mock.module('./review-history-panel.js', { namedExports: {} });
const original = new Map(
  ['location', 'localStorage'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
const memory = new Map<string, string>();
for (const [key, value] of Object.entries({
  location: new URL('http://localhost/#run/ce1c5583'),
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
}))
  Object.defineProperty(globalThis, key, { configurable: true, value });
after(() => {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const { renderRunArtifactExplorer, renderRunDetailView, renderRunGrade } =
  await import('./run-detail-renderers.js');
const { RunPipeline } = await import('./run-pipeline.js');
const { runDetailPanelOpen, toggleRunDetailPanel } = await import('./run-detail-panels.js');
const { LiveArtifactRefresh } = await import('./run-artifact-live-refresh.js');
const { rememberCollapsiblePanel } = await import('../shared/collapsible-panel.js');
const { litBinding, litText } = await import('../../testing/lit-text.js');

type RunDetailViewContext = Parameters<typeof renderRunDetailView>[0];

const artifacts: ArtifactRef[] = Array.from({ length: 12 }, (_, index) => ({
  path: `artifacts/review-${index + 1}.md`,
  purpose: 'review',
  sha256: `sha-${index}`,
}));

function agent(id: AgentContext['role']): AgentContext {
  return {
    id,
    role: id,
    label: id,
    status: 'working',
    slotId: 'macpro-mm-4',
    runId: 'ce1c5583',
    runner: 'claude',
    model: 'sonnet',
    runnerSessionId: `${id}-session`,
    target: { session: 'mm-4', window: id, pane: null, target: `mm-4:${id}` },
  };
}

// Run ce1c5583 in monitor, with review files the worker already wrote.
const run: Run = {
  id: 'ce1c5583',
  familyId: 'ce1c5583',
  lane: 'production',
  flowType: 'review-pr',
  mode: 'autonomous',
  status: 'monitoring',
  project: 'farmslot',
  ticketOrPr: 'PR-1774',
  slotId: 'macpro-mm-4',
  branch: 'feat/run-detail-live-artifacts',
  taskFile: '/tmp/ce1c5583/TASK.md',
  steps: (
    [
      ['find-slot', 'done'],
      ['write-task', 'done'],
      ['prepare', 'done'],
      ['dispatch', 'done'],
      ['monitor', 'running'],
      ['review', 'pending'],
      ['complete', 'pending'],
    ] as const
  ).map(([name, status]): RunStep => ({ name, status })),
  decisions: [],
  metrics: { nudgeCount: 0, runner: 'claude', model: 'sonnet' },
  agentContexts: [agent('review'), agent('primary')],
  grade: { difficulty: 'low', rationale: 'Small UI change', modelRecommendation: 'sonnet' },
  output: {
    capturedAt: '2026-11-02T20:00:00.000Z',
    workerFinished: false,
    artifactManifest: artifacts,
    manifestDigest: 'digest',
  },
  createdAt: '2026-11-02T19:00:00.000Z',
  updatedAt: '2026-11-02T20:00:00.000Z',
};

const ledger: AcceptanceStatusLedger = {
  schemaVersion: 1,
  criteria: [1, 2, 3, 4, 5].map((n) => ({
    id: `AC-${n}`,
    text: `Criterion ${n}`,
    verdict: n <= 3 ? 'proven' : 'missing',
    evidence: [],
    recipeNodes: [],
  })),
};

const marker = (name: string) => html`<div data-marker="${name}"></div>`;

function context(): RunDetailViewContext {
  return {
    embedded: true,
    run,
    prStatus: null,
    siblings: [],
    taskProgress: null,
    acceptanceStatus: ledger,
    acceptanceCriteria: null,
    acceptanceStatusError: null,
    acceptanceRowHeld: false,
    acceptanceEvidenceLinks: null,
    acceptanceEvidenceLinksError: null,
    acceptanceEvidenceHref: (path) => path,
    acceptanceEvidenceOpen: () => {},
    selectedStep: null,
    selectedStepProgress: null,
    _hydrating: false,
    _bootstrapFailed: false,
    _connectionStale: false,
    _directRunRefreshing: false,
    _directRunRefreshFailed: false,
    _directRunUnavailable: false,
    _rescueInProgress: false,
    _pendingConfirm: null,
    linkedTriageAssessmentId: '',
    onTriageDecisionLink: () => {},
    _showTerminal: true,
    _terminalContextId: '',
    _terminalRole: '',
    _actionsBlocked: () => false,
    _publicationActions: {},
    _retryReviewPublication: async () => {},
    _rescueLinkage: () => {},
    _confirmForceComplete: () => {},
    _confirmLifecycleAction: () => {},
    _requestCopilotRunDiagnosis: () => {},
    _rereviewLatestHead: () => {},
    _rereviewInFlight: false,
    _buildRerunAlongsideHref: () => '',
    _slotBranchForRun: () => '',
    _slotHealthForRun: () => null,
    _cancelledRunSlot: null,
    _setRunLinkedTickets: () => {},
    _setRunTags: () => {},
    _renderInteractiveDevGate: () => nothing,
    _currentCiStatus: () => null,
    _shouldShowCiStatus: () => false,
    _renderCiStatus: () => nothing,
    _renderRunEvidence: () => marker('results'),
    _renderEvidenceOverlay: () => marker('lightbox'),
    _renderPosture: () => marker('posture'),
    postureSummary: 'Active',
    _renderArtifactExplorer: () => marker('explorer'),
    panelOpen: runDetailPanelOpen,
    togglePanel: toggleRunDetailPanel,
    _renderInteractivePackets: () => nothing,
    _renderAgentSessions: () => marker('sessions'),
    _onReplayStep: () => {},
    renderGateSection: () => nothing,
    renderGrade: () => marker('grade'),
    onStepSelect: () => {},
    onStepInspectorClose: () => {},
    toggleTerminal: () => {},
  };
}

function pipeline(): InstanceType<typeof RunPipeline> {
  const element = new RunPipeline();
  element.run = run;
  element.collapsiblePanels = true;
  element.acceptanceStatus = ledger;
  element.acceptanceRowHeld = false;
  element.taskProgress = {
    schema: { flowType: 'dev', title: 'Task', totalSteps: 2, phases: [] },
    phases: [],
    totalSteps: 2,
    completedSteps: 1,
    currentPhase: null,
    currentStep: 'Inspect',
  };
  return element;
}

function inOrder(text: string, needles: string[]): void {
  let from = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle, from + 1);
    assert.ok(
      at > from,
      `${needle} comes after ${needles[needles.indexOf(needle) - 1] ?? 'start'}`,
    );
    from = at;
  }
}

test('run detail shows the header, canvas, live panels, terminal, then the reference panels', () => {
  const text = litText(renderRunDetailView(context()));
  inOrder(text, [
    'class="header"',
    '<run-pipeline',
    'slot="artifacts"',
    'data-panel="run-artifacts"',
    '</run-pipeline>',
    'data-panel="run-terminal"',
    'data-marker="results"',
    'data-panel="run-sessions"',
    'data-panel="run-posture"',
    'data-panel="run-grade"',
  ]);
});

test('inside the pipeline, the canvas comes first, then step progress, artifacts, criteria', () => {
  const text = litText(pipeline().render());
  inOrder(text, [
    'class="pipeline-svg"',
    'data-panel="run-step-progress"',
    'name="canvas-detail"',
    'name="artifacts"',
    'data-panel="run-acceptance"',
  ]);
  const outside = litText(Object.assign(pipeline(), { collapsiblePanels: false }).render());
  assert.doesNotMatch(outside, /data-panel=/, 'other surfaces keep the plain pipeline');
});

test('step progress and criteria open by default; artifacts, sessions, posture and grade do not', () => {
  const view = litText(renderRunDetailView(context()));
  assert.match(view, /data-panel="run-artifacts"\s+data-open="false"/);
  assert.match(view, /data-panel="run-sessions"\s+data-open="false"/);
  assert.match(view, /data-panel="run-posture"\s+data-open="false"/);
  assert.match(view, /data-panel="run-grade"\s+data-open="false"/);
  assert.match(
    view,
    /data-panel="run-terminal"\s+data-open="true"/,
    'the terminal keeps its state',
  );
  for (const body of ['explorer', 'sessions', 'posture', 'grade'])
    assert.doesNotMatch(view, new RegExp(`data-marker="${body}"`), `${body} is collapsed`);
  const inner = litText(pipeline().render());
  assert.match(inner, /data-panel="run-step-progress"\s+data-open="true"/);
  assert.match(inner, /data-panel="run-acceptance"\s+data-open="true"/);
  assert.match(inner, /data-testid="acceptance-panel"/);
});

test('a collapsed panel names what it holds on one line', () => {
  const view = litText(renderRunDetailView(context()));
  assert.match(view, />Artifacts<\/span[\s\S]*?>\(12\)<\/span/);
  assert.match(view, />Runner sessions<\/span[\s\S]*?>\(2\)<\/span/);
  assert.match(view, />Resource posture<\/span[\s\S]*?>\(Active\)<\/span/);
  assert.match(view, />Task estimate<\/span[\s\S]*?>\(low · sonnet\)<\/span/);
  const inner = litText(pipeline().render());
  assert.match(inner, />Acceptance criteria<\/span[\s\S]*?>\(5\/5 assessed · 3 proven\)<\/span/);
});

test("the viewer's stored choice wins and persists across runs", () => {
  memory.set('cc:panel-open:run-grade', '1');
  assert.match(
    litText(renderRunDetailView(context())),
    /data-marker="grade"/,
    'a stored open grade shows on load',
  );
  toggleRunDetailPanel('run-artifacts');
  assert.equal(memory.get('cc:panel-open:run-artifacts'), '1');
  const otherRun = litText(renderRunDetailView({ ...context(), run: { ...run, id: 'other-run' } }));
  assert.match(otherRun, /data-panel="run-artifacts"\s+data-open="true"/);
  assert.match(otherRun, /data-marker="explorer"/);
  toggleRunDetailPanel('run-step-progress');
  assert.equal(memory.get('cc:panel-open:run-step-progress'), '0');
  assert.match(litText(pipeline().render()), /data-panel="run-step-progress"\s+data-open="false"/);
});

test('the explorer renders the mirrored files while a sync is still out', () => {
  let started = 0;
  const live = new LiveArtifactRefresh({
    refresh: () => {
      started++;
      return new Promise(() => {});
    },
    onError: () => {},
  });
  live.update({ runId: run.id, active: true, open: true, unavailable: false });
  assert.equal(started, 1, 'a sync is in flight');
  const explorer = renderRunArtifactExplorer(run, {
    artifactUrl: (artifact) => `/api/run-artifact?path=${artifact.path}`,
    onEvidenceArtifactClick: () => {},
    syncError: null,
  });
  const text = litText(explorer);
  assert.match(text, /<step-artifacts/);
  assert.doesNotMatch(text, /Syncing|Loading|spinner/i);
  const shown = litBinding(explorer, '.artifacts=');
  assert.ok(Array.isArray(shown));
  assert.deepEqual(
    shown.map((entry: { path: string }) => entry.path),
    artifacts.map((artifact) => artifact.path),
  );
  live.dispose();
});

test('a failed sync keeps the mirrored files and adds one note', () => {
  const text = litText(
    renderRunArtifactExplorer(run, {
      artifactUrl: () => '',
      onEvidenceArtifactClick: () => {},
      syncError: 'slot unreachable',
    }),
  );
  assert.match(text, /<step-artifacts/);
  assert.match(text, /Sync failed: slot unreachable\. Showing the last mirrored copy\./);
});

test('closing results never hides the artifact explorer lightbox', () => {
  const text = litText(
    renderRunDetailView({ ...context(), panelOpen: (id) => id !== 'run-results' }),
  );
  assert.doesNotMatch(text, /data-marker="results"/);
  assert.match(text, /data-marker="lightbox"/);
});

test('review and interactive actions remain available below the canvas', () => {
  const decision: RunDecision = {
    id: 'review-posting',
    type: 'engine_review_posting',
    title: 'Review output',
    description: '',
    actions: [],
    createdAt: run.createdAt,
  };
  const text = litText(
    renderRunDetailView({
      ...context(),
      run: { ...run, decisions: [decision] },
      renderGateSection: () => marker('review-gate'),
      _renderInteractiveDevGate: () => marker('interactive-gate'),
    }),
  );
  inOrder(text, [
    'class="header"',
    '<run-pipeline',
    'data-panel="run-results"',
    'data-marker="review-gate"',
    'data-marker="interactive-gate"',
  ]);
});

test('a selected canvas or hash-linked step stays visible while progress is collapsed', () => {
  rememberCollapsiblePanel('run-step-progress', false);
  for (const selected of ['monitor', 'pre-gate-publication-review-active']) {
    const element = pipeline();
    element.selectedStepName = selected;
    const text = litText(element.render());
    const progress = text.indexOf('data-panel="run-step-progress"');
    const closed = text.indexOf('</section>', progress);
    const inspector = text.indexOf('name="canvas-detail"');
    assert.ok(inspector > closed && inspector < text.indexOf('name="artifacts"'));
    assert.match(text, /data-panel="run-step-progress"\s+data-open="false"/);
  }
  assert.doesNotMatch(litText(pipeline().render()), /name="canvas-detail"/);
  rememberCollapsiblePanel('run-step-progress', true);
});

test('background transfer activity never inserts a row above the live panels', async () => {
  const element = pipeline();
  const afterCanvas = () => {
    const text = litText(element.render());
    return text.slice(text.lastIndexOf('</svg>') + 6);
  };
  const idle = afterCanvas();
  const transfer: FileTransferUiEntry = {
    transferId: 'mirror',
    runId: run.id,
    path: 'artifacts',
    phase: 'mirror',
    state: 'running',
    bytesTransferred: 0,
    totalBytes: 100,
    updatedAt: 0,
  };
  Reflect.set(element, 'transferProgress', transfer);
  assert.equal(afterCanvas(), idle);
  element.collapsiblePanels = false;
  assert.match(litText(element.render()), /class="pipeline-transfer-strip"/);
  const store = await import('../shared/file-transfer-progress-store.js');
  const release = store.retainFileTransferStore();
  try {
    const deadline = Date.now() + 1000;
    while (!transferProgressListener) {
      assert(Date.now() < deadline);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    transferProgressListener(transfer);
    const view = litText(renderRunDetailView({ ...context(), panelOpen: () => true }));
    inOrder(view, [
      'data-panel="run-grade"',
      'data-panel="run-transfers"',
      '<file-transfer-progress-banner',
    ]);
  } finally {
    store._resetFileTransferStoreForTests();
    release();
  }
});

test('empty progress and transfer panels stay absent, while a selected step still has its inspector', () => {
  const element = pipeline();
  element.taskProgress = undefined;
  const initial = litText(element.render());
  assert.doesNotMatch(initial, /data-panel="run-step-progress"/);
  assert.doesNotMatch(litText(renderRunDetailView(context())), /data-panel="run-transfers"/);
  element.selectedStepName = 'monitor';
  assert.match(litText(element.render()), /name="canvas-detail"/);
});

test('the task estimate names its purpose and recommended model', () => {
  const text = litText(renderRunDetailView(context()));
  assert.match(text, /Task estimate/);
  const estimate = litText(renderRunGrade(run.grade!));
  assert.match(estimate, /Task difficulty and suggested model, estimated before execution/);
  assert.match(estimate, /Suggested model: sonnet/);
});

test('waiting for the operator preserves an existing monitor checklist', () => {
  const element = pipeline();
  element.run = {
    ...run,
    waitingForOperator: {
      contextId: 'worker',
      attemptId: 'attempt',
      who: 'operator',
      reason: 'Confirm the next step',
      since: '2026-11-02T20:00:00Z',
    },
  };
  const waiting = litText(element.render());
  assert.match(waiting, /data-panel="run-step-progress"/);
  assert.match(waiting, /1\/2/);
  element.run = run;
  assert.match(litText(element.render()), /data-panel="run-step-progress"/);
});

test('waiting checklist summaries retain running-step and completion labels', () => {
  const element = pipeline();
  element.run = {
    ...run,
    waitingForOperator: {
      contextId: 'worker',
      attemptId: 'attempt',
      who: 'operator',
      reason: 'Confirm the next step',
      since: '2026-11-02T20:00:00Z',
    },
  };
  const progress = element.taskProgress!;
  for (const currentStep of [null, '  ']) {
    element.taskProgress = {
      ...progress,
      currentStep,
      phases: [
        {
          name: 'Review',
          completedSteps: 1,
          totalSteps: 2,
          steps: [{ index: 0, name: 'Inspect diff', status: 'running' }],
        },
      ],
    };
    assert.match(litText(element.render()), /1\/2 · Inspect diff/);
  }
  element.taskProgress = { ...progress, currentStep: null, completedSteps: 2, phases: [] };
  assert.match(litText(element.render()), /2\/2 · Checklist complete/);
});
