import { html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  BacklogItem,
  DispatchCandidatesResult,
  EvalExperimentCreateResult,
  EvalTrialStartResult,
  ExecutionTemplateCatalogOption,
  ExecutionTemplateOptions,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
  FleetStatus,
  GatewayUpdateStatus,
  InteractiveOperatorPacket,
  ProjectConfig,
  PRStatus,
  QueueItem,
  ResultPackageManifest,
  RoadmapDeliveryProjection,
  RoadmapItem,
  Run,
  SlotHealth,
  SlotStatus,
} from '@farmslot/protocol';
import type { ReadyGatePayload, ReviewGatePayload, RunDecision } from '@farmslot/protocol';
import { INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1 } from '@farmslot/protocol';

// Import components we're showcasing
import '../components/fleet-map/slot-card.js';
import '../components/fleet-map/fleet-canvas.js';
import '../components/fleet-map/machine-group.js';
import '../components/pr-dashboard/pr-card.js';
import '../components/pr-dashboard/pr-board.js';
import '../components/decisions/decision-inbox.js';
import '../components/terminal/terminal-view.js';
import '../components/terminal/split-view.js';
import '../components/shared/execution-template-picker.js';
import '../components/shared/summary-bar.js';
import '../components/violations/violation-feed.js';
import '../components/progress-tracker/progress-tracker.js';
import '../components/diff-viewer/diff-review.js';
import '../components/diff-viewer/code-viewer.js';
import '../components/workspace/file-tree.js';
import '../components/workspace/git-changes.js';
import '../components/workspace/metro-log-viewer.js';
import '../components/workspace/slot-workspace.js';
import '../components/slot-view/slot-view.js';
import '../components/slot-view/slot-history-modal.js';
import '../components/slot-view/slot-load-run-modal.js';
import '../components/stream-feed/stream-feed.js';
import '../components/runs/run-list.js';
import '../components/runs/run-detail.js';
import '../components/runs/run-tag-editor.js';
import '../components/runs/run-pipeline.js';
import '../components/config/llm-config.js';
import './improvement-dev.js';
import '../components/runs/run-pipeline-mini.js';
import '../components/flow-graph/flow-graph.js';
import '../components/runs/step-inspector.js';
import '../components/shared/step-artifacts.js';
import '../components/shared/diff-viewer-modal.js';
import '../components/workspace/review-workspace.js';
import '../components/workspace/ready-workspace.js';
import '../components/shared/global-filter-bar.js';
import '../components/shared/linked-run-summary.js';
import '../components/shared/runner-model-effort-picker.js';
import '../components/shared/slot-choice-list.js';
import '../components/shared/slot-selector-modal.js';
import '../components/runs/family-observability.js';
import '../components/intelligence-audit/intelligence-audit-panel.js';
import '../components/intelligence-audit/intelligence-incidents-panel.js';
import '../components/interactive/interactive-operator-packets.js';
import '../components/evals/eval-cockpit.js';
import '../components/queue/dispatch-queue-panel.js';
import '../components/dispatch/dispatch-wizard.js';
import '../components/backlog/backlog-panel.js';
import '../components/roadmap/roadmap-panel.js';
import '../components/work-graph/work-graph-panel.js';
import '../components/resources/resource-panel.js';
import '../components/device-grid/device-grid.js';
import './chat-dev.js';
import './terminal-attachment-dev.js';
import './machine-health-dev.js';
import './machine-pause-dev.js';
import './config-dev.js';
import '../components/recipe-graph/recipe-graph.js';
import '../components/slot-actions/slot-actions-panel.js';
import '../components/slot-actions/slot-actions-modal.js';
import '../components/shared/update-banner.js';

import { buildCaseCatalog, catalogItemFromManual } from '../components/evals/eval-suite-helpers.js';
import type { RunnerModelEffortChangeDetail } from '../components/shared/runner-model-effort-picker.js';
import type { SlotChoiceChangeDetail } from '../components/shared/slot-choice-list.js';
import type { StreamFeed } from '../components/stream-feed/stream-feed.js';
import {
  type AppStateSliceSnapshot,
  captureStateSlices,
  restoreStateSlices,
  updateBacklogItems,
  updateDecisions,
  updateFleet,
  updatePRs,
  updateQueueItems,
  updateRuns,
} from '../state.js';
import { colors, fonts, spacing } from '../styles/theme-tokens.js';
import type { EffortLevel } from '../utils/runner-options.js';

import {
  mockDecisions,
  mockFamilyObservabilitySnapshot,
  mockFileTree,
  mockFleetSlots,
  mockFleetStatus,
  mockGitChanges,
  mockHealth,
  mockMetroLines,
  mockPipelineRuns,
  mockPRList,
  mockRecipeProvenanceScenarios,
  mockRecipes,
  mockRuns,
  mockSlot,
  mockSlotRunHistory,
  mockStructuredProgress,
  mockTaskMarkdown,
  mockViolations,
  mockWorkspaceDiffs,
  mockWorkspaceFiles,
} from './mock-data.js';
import { MOCK_CHANGED_LINES, MOCK_MODIFIED_SOURCE, MOCK_UNIFIED_DIFF } from './mock-diff-data.js';
import { MockH264Source } from './mock-h264-source.js';
import { mockWorkGraphBacklogItems, mockWorkGraphs } from './mock-work-graph-data.js';

type DevRoute =
  | 'slot-card'
  | 'fleet-map'
  | 'slot-actions'
  | 'fleet-refresh'
  | 'terminal'
  | 'terminal-attachment'
  | 'terminal-grid'
  | 'pr-board'
  | 'decisions'
  | 'violations'
  | 'progress'
  | 'diff'
  | 'diff-viewer-modal'
  | 'code-editor'
  | 'file-tree'
  | 'git-changes'
  | 'metro-log'
  | 'workspace'
  | 'slot-view'
  | 'slot-history'
  | 'slot-load-run'
  | 'recipe-provenance-matrix'
  | 'dispatch-wizard'
  | 'execution-template-picker'
  | 'dispatch-queue'
  | 'backlog'
  | 'roadmap'
  | 'stream-feed'
  | 'runs'
  | 'run-detail'
  | 'run-tag-editor'
  | 'pipeline'
  | 'pipeline-mini'
  | 'linked-run-summary'
  | 'flow-graph'
  | 'work-graph'
  | 'review-workspace'
  | 'ready-workspace'
  | 'global-filter'
  | 'runner-model-effort'
  | 'slot-choice-list'
  | 'slot-selector'
  | 'step-inspector'
  | 'step-artifacts'
  | 'resource-panel'
  | 'device-grid'
  | 'interactive-packets'
  | 'chat'
  | 'machine-health'
  | 'machine-pause'
  | 'config'
  | 'llm-settings'
  | 'improvement'
  | 'recipe-graph'
  | 'family-observability'
  | 'eval-cockpit'
  | 'intelligence-audit'
  | 'intelligence-incidents'
  | 'update-banner'
  | 'index';

type DevHarnessGroup = 'screens' | 'components' | 'experiments';

const DEV_ROUTE_GROUP_LABELS: Record<DevHarnessGroup, string> = {
  screens: 'Screens',
  components: 'Components',
  experiments: 'Experiments',
};

const DEV_ROUTES: Array<{ route: DevRoute; label: string; group: DevHarnessGroup }> = [
  { route: 'fleet-map', label: 'Fleet Map', group: 'screens' },
  { route: 'terminal-grid', label: 'Terminal Grid', group: 'screens' },
  { route: 'pr-board', label: 'PR Board', group: 'screens' },
  { route: 'decisions', label: 'Decisions', group: 'screens' },
  { route: 'workspace', label: 'Workspace', group: 'screens' },
  { route: 'slot-view', label: 'Slot View', group: 'screens' },
  { route: 'dispatch-wizard', label: 'Dispatch Wizard', group: 'screens' },
  { route: 'execution-template-picker', label: 'Execution Template Picker', group: 'components' },
  { route: 'dispatch-queue', label: 'Dispatch Queue', group: 'screens' },
  { route: 'backlog', label: 'Backlog', group: 'screens' },
  { route: 'roadmap', label: 'Roadmap', group: 'screens' },
  { route: 'work-graph', label: 'Work Graph Epic Demo', group: 'screens' },
  { route: 'runs', label: 'Runs', group: 'screens' },
  { route: 'run-detail', label: 'Run Detail', group: 'screens' },
  { route: 'review-workspace', label: 'Review Workspace', group: 'screens' },
  { route: 'ready-workspace', label: 'Ready Workspace', group: 'screens' },
  { route: 'device-grid', label: 'Device Grid', group: 'screens' },
  { route: 'chat', label: 'Chat Co-Pilot', group: 'screens' },
  { route: 'machine-health', label: 'Machine Health', group: 'screens' },
  { route: 'machine-pause', label: 'Machine Pause & Restore', group: 'components' },
  { route: 'config', label: 'Config Manager', group: 'screens' },
  { route: 'llm-settings', label: 'LLM Settings', group: 'screens' },
  { route: 'family-observability', label: 'Retrospective', group: 'screens' },
  { route: 'eval-cockpit', label: 'Eval Cockpit', group: 'screens' },
  { route: 'intelligence-audit', label: 'Intelligence Audit', group: 'screens' },
  { route: 'intelligence-incidents', label: 'Intelligence Incidents (new)', group: 'screens' },

  { route: 'slot-card', label: 'Slot Cards', group: 'components' },
  { route: 'slot-actions', label: 'Slot Actions', group: 'components' },
  { route: 'fleet-refresh', label: 'Fleet Refresh', group: 'components' },
  { route: 'terminal', label: 'Terminal', group: 'components' },
  { route: 'terminal-attachment', label: 'Terminal Attachments', group: 'components' },
  { route: 'violations', label: 'Violations', group: 'components' },
  { route: 'progress', label: 'Progress', group: 'components' },
  { route: 'diff', label: 'Diff Viewer', group: 'components' },
  { route: 'diff-viewer-modal', label: 'Diff Modal', group: 'components' },
  { route: 'code-editor', label: 'Code Editor', group: 'components' },
  { route: 'file-tree', label: 'File Tree', group: 'components' },
  { route: 'git-changes', label: 'Git Changes', group: 'components' },
  { route: 'metro-log', label: 'Metro Log', group: 'components' },
  { route: 'slot-history', label: 'Slot History', group: 'components' },
  { route: 'slot-load-run', label: 'Slot Load Run', group: 'components' },
  { route: 'stream-feed', label: 'Stream Feed', group: 'components' },
  { route: 'run-tag-editor', label: 'Run Tag Editor', group: 'components' },
  { route: 'linked-run-summary', label: 'Linked Run Summary', group: 'components' },
  { route: 'pipeline', label: 'Pipeline', group: 'components' },
  { route: 'pipeline-mini', label: 'Pipeline Mini', group: 'components' },
  { route: 'global-filter', label: 'Global Filter', group: 'components' },
  { route: 'runner-model-effort', label: 'Runner Model Effort', group: 'components' },
  { route: 'slot-choice-list', label: 'Slot Choice List', group: 'components' },
  { route: 'slot-selector', label: 'Slot Selector', group: 'components' },
  { route: 'step-inspector', label: 'Step Inspector', group: 'components' },
  { route: 'step-artifacts', label: 'Step Artifacts', group: 'components' },
  { route: 'resource-panel', label: 'Resource Panel', group: 'components' },
  { route: 'update-banner', label: 'Update Banner', group: 'components' },
  { route: 'interactive-packets', label: 'Interactive Packets', group: 'components' },

  { route: 'recipe-provenance-matrix', label: 'Recipe Provenance Matrix', group: 'experiments' },
  { route: 'flow-graph', label: 'Flow Graph', group: 'experiments' },
  { route: 'improvement', label: 'Improvement Playground', group: 'experiments' },
  { route: 'recipe-graph', label: 'Recipe Graph', group: 'experiments' },
];

const DEV_ROUTE_GROUPS: DevHarnessGroup[] = ['screens', 'components', 'experiments'];
const VALID_DEV_ROUTES = new Set<DevRoute>(DEV_ROUTES.map(({ route }) => route));

@customElement('dev-harness')
export class DevHarness extends LitElement {
  @state() private route: DevRoute = 'index';
  @state() private _pickerDomain = 'perps';
  @state() private _pickerMode: 'autonomous' | 'interactive' = 'autonomous';
  @state() private _pickerSelectedId = '';
  @state() private _captureMode = false;
  @state() private _selectedFile = '';
  @state() private _recipeProvenanceScenarioId = 'decision-review';
  @state() private _metroLines: string[] = [];
  @state() private _feedFps = 15;
  @state() private _feedRunning = false;
  @state() private _diffViewerModalOpen = true;
  @state() private _slotSelectorSelection = ['runner-local-mobile-2'];
  @state() private _slotChoiceSelection = ['runner-local-mobile-2'];
  @state() private _pickerRunner = 'codex';
  @state() private _pickerModel = 'gpt-5.5';
  @state() private _pickerEffort: EffortLevel = 'medium';
  private _stateSnapshot: AppStateSliceSnapshot | null = null;
  private _metroInterval: ReturnType<typeof setInterval> | null = null;
  private _mockSource1: MockH264Source | null = null;
  private _mockSource2: MockH264Source | null = null;

  // Light DOM so Monaco/diff2html CSS from document.head works
  protected override createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.parseRoute();
    window.addEventListener('hashchange', this.onHashChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.onHashChange);
    if (this._metroInterval) {
      clearInterval(this._metroInterval);
      this._metroInterval = null;
    }
    this._stopMockSources();
    this._restoreSharedState();
  }

  private onHashChange = () => {
    this.parseRoute();
  };

  private parseRoute() {
    const rawHash = location.hash.slice(1);
    const routePart = rawHash.split('?')[0];
    const query = rawHash.includes('?') ? rawHash.slice(rawHash.indexOf('?') + 1) : '';
    const params = new URLSearchParams(query);
    this._captureMode =
      params.get('capture') === '1' || params.get('demo') === '1' || params.get('focus') === '1';
    this.classList.toggle('capture-mode', this._captureMode);

    if (routePart !== 'dev' && !routePart.startsWith('dev/')) {
      this._restoreSharedState();
      return;
    }
    const hash =
      routePart === 'dev'
        ? 'index'
        : routePart.startsWith('dev/')
          ? routePart.slice('dev/'.length)
          : routePart;
    const next = VALID_DEV_ROUTES.has(hash as DevRoute) ? (hash as DevRoute) : 'index';
    // Cleanup mock sources when navigating away from stream-feed
    if (this.route === 'stream-feed' && next !== 'stream-feed') {
      this._stopMockSources();
    }
    this.route = next;
  }

  private _captureSharedState() {
    this._stateSnapshot ??= captureStateSlices();
  }

  private _restoreSharedState() {
    if (!this._stateSnapshot) return;
    restoreStateSlices(this._stateSnapshot);
    this._stateSnapshot = null;
  }

  private _updateMockFleet(fleet: FleetStatus) {
    this._captureSharedState();
    updateFleet(fleet);
  }

  private _updateMockPRs(prs: PRStatus[]) {
    this._captureSharedState();
    updatePRs(prs);
  }

  private _updateMockQueueItems(items: QueueItem[]) {
    this._captureSharedState();
    updateQueueItems(items);
  }

  private _updateMockRuns(runs: Run[]) {
    this._captureSharedState();
    updateRuns(runs);
  }

  private renderContent() {
    switch (this.route) {
      case 'slot-card':
        return this.renderSlotCards();
      case 'fleet-map':
        return this.renderFleetMap();
      case 'slot-actions':
        return this.renderSlotActions();
      case 'fleet-refresh':
        return this.renderFleetRefresh();
      case 'terminal':
        return this.renderTerminal();
      case 'terminal-attachment':
        return this.renderTerminalAttachment();
      case 'terminal-grid':
        return this.renderTerminalGrid();
      case 'pr-board':
        return this.renderPRBoard();
      case 'decisions':
        return this.renderDecisions();
      case 'violations':
        return this.renderViolations();
      case 'progress':
        return this.renderProgress();
      case 'diff':
        return this.renderDiff();
      case 'diff-viewer-modal':
        return this.renderDiffViewerModal();
      case 'code-editor':
        return this.renderCodeEditor();
      case 'file-tree':
        return this.renderFileTree();
      case 'git-changes':
        return this.renderGitChanges();
      case 'metro-log':
        return this.renderMetroLog();
      case 'workspace':
        return this.renderWorkspace();
      case 'slot-view':
        return this.renderSlotView();
      case 'slot-history':
        return this.renderSlotHistory();
      case 'slot-load-run':
        return this.renderSlotLoadRun();
      case 'recipe-provenance-matrix':
        return this.renderRecipeProvenanceMatrix();
      case 'dispatch-wizard':
        return this.renderDispatchWizard();
      case 'execution-template-picker':
        return this.renderExecutionTemplatePicker();
      case 'dispatch-queue':
        return this.renderDispatchQueue();
      case 'backlog':
        return this.renderBacklog();
      case 'roadmap':
        return this.renderRoadmap();
      case 'stream-feed':
        return this.renderStreamFeed();
      case 'runs':
        return this.renderRuns();
      case 'run-detail':
        return this.renderRunDetail();
      case 'run-tag-editor':
        return this.renderRunTagEditor();
      case 'pipeline':
        return this.renderPipeline();
      case 'pipeline-mini':
        return this.renderPipelineMini();
      case 'linked-run-summary':
        return this.renderLinkedRunSummary();
      case 'flow-graph':
        return this.renderFlowGraph();
      case 'work-graph':
        return this.renderWorkGraph();
      case 'review-workspace':
        return this.renderReviewWorkspace();
      case 'ready-workspace':
        return this.renderReadyWorkspace();
      case 'global-filter':
        return this.renderGlobalFilter();
      case 'runner-model-effort':
        return this.renderRunnerModelEffortPicker();
      case 'slot-choice-list':
        return this.renderSlotChoiceList();
      case 'slot-selector':
        return this.renderSlotSelector();
      case 'step-inspector':
        return this.renderStepInspector();
      case 'step-artifacts':
        return this.renderStepArtifacts();
      case 'resource-panel':
        return this.renderResourcePanel();
      case 'device-grid':
        return this.renderDeviceGrid();
      case 'interactive-packets':
        return this.renderInteractivePackets();
      case 'chat':
        return html`<chat-dev-harness></chat-dev-harness>`;
      case 'machine-health':
        return html`<machine-health-dev></machine-health-dev>`;
      case 'machine-pause':
        return html`<machine-pause-dev></machine-pause-dev>`;
      case 'config':
        return html`<config-dev></config-dev>`;
      case 'llm-settings':
        return html`<llm-config></llm-config>`;
      case 'improvement':
        return html`<improvement-dev></improvement-dev>`;
      case 'recipe-graph':
        return this.renderRecipeGraph();
      case 'family-observability':
        return this.renderFamilyObservability();
      case 'intelligence-audit':
        return html`<intelligence-audit-panel></intelligence-audit-panel>`;
      case 'intelligence-incidents':
        return this.renderIntelligenceIncidents();
      case 'eval-cockpit':
        return this.renderEvalCockpit();
      case 'update-banner':
        return this.renderUpdateBanner();
      default:
        return this.renderIndex();
    }
  }

  private renderWorkGraph() {
    const graph = mockWorkGraphs[0];
    const node = graph.nodes.find(
      (candidate) => candidate.backlogItemId === 'bl_demo_gateway_projection',
    );
    let demoRuns = mockPipelineRuns();
    if (node?.backlogItemId) {
      const linkedRun: Run = {
        ...mockPipelineRuns()[0],
        id: node.latestRunId ?? 'run_demo_gateway_tests',
        familyId: node.currentFamilyId ?? 'fam_demo_gateway_projection',
        project: 'gateway',
        ticketOrPr: node.backlogItemId,
        backlogItemId: node.backlogItemId,
        workGraphId: graph.graph.id,
        workNodeId: node.id,
        updatedAt: new Date().toISOString(),
      };
      demoRuns = [...demoRuns, linkedRun];
    }
    return html`<work-graph-panel
      .demoGraphs=${mockWorkGraphs}
      .demoBacklogItems=${mockWorkGraphBacklogItems}
      .demoRuns=${demoRuns}
    ></work-graph-panel>`;
  }

  private renderInteractivePackets() {
    const packetPath = 'artifacts/interactive/review-plan.packet.json';
    const bodyPath = 'artifacts/interactive/review-plan.md';
    const packet: InteractiveOperatorPacket = {
      schema: INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1,
      id: 'dev-review-plan',
      runId: 'dev-run-1',
      title: 'Review the packet protocol slice',
      intent: 'review',
      summary: 'Confirm the first Command Center and Companion renderer behavior.',
      body: { format: 'markdown', path: bodyPath },
      anchors: [
        {
          id: 'adr',
          label: 'ADR-048',
          artifactPath: 'docs/adr/048-interactive-operator-packets.md',
          line: 1,
        },
      ],
      actions: [
        {
          id: 'copy-summary',
          label: 'Copy summary',
          kind: 'copy',
          safety: 'read-only',
          payload: { text: 'Interactive packet renderer reviewed.' },
        },
        {
          id: 'open-adr',
          label: 'Open ADR',
          kind: 'open-artifact',
          safety: 'read-only',
          payload: { artifactPath: 'docs/adr/048-interactive-operator-packets.md' },
        },
      ],
      createdAt: '2026-07-03T00:00:00.000Z',
    };
    const body = [
      '## Scope',
      '',
      '- Render packet body markdown.',
      '- Show artifact anchors.',
      '- Expose only allowlisted actions.',
      '',
      'Mutating actions still require operator confirmation.',
    ].join('\n');
    const loader = async (path: string): Promise<string> => {
      if (path === packetPath) return JSON.stringify(packet);
      if (path === bodyPath) return body;
      return `# ${path}\n\nMock artifact opened from the interactive packet harness.`;
    };

    return html`
      <div style="max-width: 900px">
        <interactive-operator-packets
          runId="dev-run-1"
          slotId="dev-slot-1"
          .artifacts=${[
            {
              path: packetPath,
              purpose: 'interactive-packet',
              type: 'interactive-packet',
              mimeType: 'application/vnd.farmslot.operator-packet+json',
            },
          ]}
          .artifactTextLoader=${loader}
        ></interactive-operator-packets>
      </div>
    `;
  }

  private renderUpdateBanner() {
    const behind: GatewayUpdateStatus = {
      updateAvailable: true,
      commitsBehind: 7,
      commitsAhead: 0,
      branch: 'main',
      localSha: 'a1b2c3d',
      remoteSha: 'e4f5a6b',
      lastChecked: '2026-06-23T10:00:00.000Z',
      updateCommand: 'farmslot update',
      error: null,
    };
    const upToDate: GatewayUpdateStatus = { ...behind, updateAvailable: false, commitsBehind: 0 };
    return html`
      <div style="display:flex;flex-direction:column;gap:16px">
        <div>
          <div style="color:#888;font:0.7rem monospace;padding:4px 16px">update available</div>
          <update-banner .status=${behind}></update-banner>
        </div>
        <div>
          <div style="color:#888;font:0.7rem monospace;padding:4px 16px">
            up to date (renders nothing)
          </div>
          <update-banner .status=${upToDate}></update-banner>
        </div>
      </div>
    `;
  }

  private renderEvalCockpit() {
    const referencePackage: ResultPackageManifest = {
      version: 1,
      kind: 'result-package',
      packageId: 'pkg-reference',
      packageHash: 'hash-reference',
      status: 'final',
      createdAt: '2026-05-09T00:00:00.000Z',
      finalizedAt: '2026-05-09T00:02:00.000Z',
      project: 'example-mobile-farm',
      familyId: 'family-eval-dev',
      objectiveHash: 'objective-template-regression',
      taskProfile: 'fix-bug',
      source: {
        kind: 'merged-pr',
        repo: 'example-org/example-mobile',
        prNumber: 27901,
        title: 'Fix secure keychain unlock race',
      },
      role: 'reference',
      diff: {
        source: 'artifact',
        available: true,
        files: 2,
        additions: 18,
        deletions: 3,
        kind: 'contribution',
      },
      axes: {
        template: { path: 'templates/worker/fix-bug.md', hash: 'current' },
        runner: { name: 'claude' },
        model: { name: 'sonnet' },
      },
      visualEvidence: [],
      validationEvidence: [],
      reviewEvidence: [],
      outcomeClaims: ['Reference PR fixed the unlock race.'],
      metrics: { durationMs: 1800000, costEstimate: 2.42, sessionTurns: 8 },
      missingData: [],
    };
    const evalResult: EvalExperimentCreateResult = {
      experimentId: 'eval-template-regression',
      experimentKey: 'experiment-key-template-regression',
      familyId: 'family-eval-dev',
      experimentManifestPath:
        '/tmp/farmslot/evals/eval-template-regression/artifacts/experiment-manifest.json',
      referencePackagePath:
        '/tmp/farmslot/evals/eval-template-regression/artifacts/packages/reference.result-package.json',
      referencePackage,
      experimentManifest: {
        version: 1,
        kind: 'eval-experiment',
        experimentId: 'eval-template-regression',
        experimentKey: 'experiment-key-template-regression',
        createdAt: '2026-05-09T00:00:00.000Z',
        updatedAt: '2026-05-09T00:05:00.000Z',
        project: 'example-mobile-farm',
        familyId: 'family-eval-dev',
        case: {
          caseId: 'case-mm-pr-27901',
          source: referencePackage.source,
          taskProfile: 'fix-bug',
          objectiveHash: 'objective-template-regression',
          referencePackageId: 'pkg-reference',
          referencePackageHash: 'hash-reference',
          referencePackagePath: '/tmp/reference.result-package.json',
          label: 'merged PR reference',
        },
        rubric: {
          taskProfile: 'fix-bug',
          rubricId: 'eval-default',
          rubricVersion: '1',
          requiredEvidence: [],
        },
        candidateStrategies: [],
        trials: [],
        missingData: [],
      },
    };
    const candidatePackage = (
      packageId: string,
      label: string,
      hash: string,
      runId: string,
      durationMs: number,
      costEstimate: number,
    ): ResultPackageManifest => ({
      ...referencePackage,
      packageId,
      packageHash: `hash-${packageId}`,
      role: 'candidate' as const,
      runId,
      axes: {
        template: { path: 'templates/worker/fix-bug.md', hash },
        runner: { name: 'codex' },
        model: { name: 'gpt-5.5' },
      },
      diff: {
        source: 'artifact' as const,
        available: true,
        files: hash === 'proposed' ? 2 : 3,
        additions: hash === 'proposed' ? 10 : 24,
        deletions: hash === 'proposed' ? 1 : 4,
        kind: 'contribution' as const,
      },
      visualEvidence: [],
      validationEvidence: [
        {
          runId,
          familyId: 'family-eval-dev',
          path: 'artifacts/report.md',
          purpose: 'report',
          source: 'task-artifact' as const,
        },
      ],
      metrics: { durationMs, costEstimate, sessionTurns: hash === 'proposed' ? 11 : 14 },
      missingData: hash === 'proposed' ? [] : ['visual-evidence-missing'],
      outcomeClaims: [`${label} completed locally.`],
    });
    const appendResults: EvalTrialStartResult[] = [
      {
        experimentId: evalResult.experimentId,
        experimentKey: evalResult.experimentKey,
        deduped: false,
        strategyId: 'strategy-current-template',
        trialId: 'trial-current-template',
        candidateStrategyFingerprint: 'axis-current-template',
        experimentManifestPath: evalResult.experimentManifestPath,
        experimentManifest: {
          ...evalResult.experimentManifest,
          candidateStrategies: [
            {
              strategyId: 'strategy-current-template',
              label: 'current bugfix template',
              candidateStrategyFingerprint: 'axis-current-template',
              axes: {
                template: { path: 'templates/worker/fix-bug.md', hash: 'current' },
                runner: { name: 'codex' },
                model: { name: 'gpt-5.5' },
              },
            },
          ],
          trials: [
            {
              trialId: 'trial-current-template',
              strategyId: 'strategy-current-template',
              caseId: 'case-mm-pr-27901',
              status: 'final',
              packageId: 'pkg-current',
              packageHash: 'hash-pkg-current',
              packagePath: '/tmp/current.result-package.json',
              runId: 'run-current',
              missingData: [],
            },
          ],
        },
        candidatePackage: candidatePackage(
          'pkg-current',
          'current bugfix template',
          'current',
          'run-current',
          2400000,
          3.82,
        ),
        candidatePackagePath: '/tmp/current.result-package.json',
        run: undefined,
        taskPath: '/tmp/current/TASK.md',
        artifactDir: '/tmp/current/artifacts',
      },
      {
        experimentId: evalResult.experimentId,
        experimentKey: evalResult.experimentKey,
        deduped: false,
        strategyId: 'strategy-proposed-template',
        trialId: 'trial-proposed-template',
        candidateStrategyFingerprint: 'axis-proposed-template',
        experimentManifestPath: evalResult.experimentManifestPath,
        experimentManifest: {
          ...evalResult.experimentManifest,
          candidateStrategies: [
            {
              strategyId: 'strategy-proposed-template',
              label: 'proposed bugfix template',
              candidateStrategyFingerprint: 'axis-proposed-template',
              axes: {
                template: { path: 'templates/worker/fix-bug.md', hash: 'proposed' },
                runner: { name: 'codex' },
                model: { name: 'gpt-5.5' },
              },
            },
          ],
          trials: [
            {
              trialId: 'trial-proposed-template',
              strategyId: 'strategy-proposed-template',
              caseId: 'case-mm-pr-27901',
              status: 'final',
              packageId: 'pkg-proposed',
              packageHash: 'hash-pkg-proposed',
              packagePath: '/tmp/proposed.result-package.json',
              runId: 'run-proposed',
              missingData: [],
            },
          ],
        },
        candidatePackage: candidatePackage(
          'pkg-proposed',
          'proposed bugfix template',
          'proposed',
          'run-proposed',
          420000,
          3.08,
        ),
        candidatePackagePath: '/tmp/proposed.result-package.json',
        run: undefined,
        taskPath: '/tmp/proposed/TASK.md',
        artifactDir: '/tmp/proposed/artifacts',
      },
    ];
    const manualPackage = catalogItemFromManual({
      kind: 'package',
      project: 'example-mobile-farm',
      taskProfile: 'fix-bug',
      packagePath: '/tmp/farmslot/evals/reference.result-package.json',
      label: 'known package reference',
    });
    const manualGitRef = catalogItemFromManual({
      kind: 'git-ref',
      project: 'example-mobile-farm',
      taskProfile: 'dev',
      gitRef: 'template-regression-baseline',
      gitRepository: 'example-org/example-mobile',
      label: 'baseline git ref',
    });
    const caseCatalog = [
      ...buildCaseCatalog({ prs: mockPRList(), runs: mockRuns() }),
      ...(manualPackage ? [manualPackage] : []),
      ...(manualGitRef ? [manualGitRef] : []),
    ];
    const initialSelectedCaseIds = caseCatalog
      .filter((item) => item.selectable)
      .slice(0, 2)
      .map((item) => item.id);
    return html`<eval-cockpit
      mock
      .evalResultOverride=${evalResult}
      .appendResultsOverride=${appendResults}
      .caseCatalogOverride=${caseCatalog}
      .initialSelectedCaseIds=${initialSelectedCaseIds}
    ></eval-cockpit>`;
  }

  private renderRecipeGraph() {
    const recipes = mockRecipes();
    return html`
      <p class="section-label">Recipe graph — 3 scenarios (linear, branching, retry loop)</p>
      ${recipes.map(
        ({ label, recipe }) => html`
          <p class="section-label" style="margin-top: 20px; color: ${colors.accent}">${label}</p>
          <div
            style="height: 300px; border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden; margin-bottom: 8px"
          >
            <recipe-graph .recipe=${recipe}></recipe-graph>
          </div>
        `,
      )}
    `;
  }

  private renderFamilyObservability() {
    const snapshot = mockFamilyObservabilitySnapshot();
    const fullRuns = this._familySnapshotRuns(snapshot);
    return html`
      <p class="section-label">Retrospective — family-first historical view</p>
      <family-observability
        .familyId=${'family-proj-2501'}
        .initialRunId=${snapshot.latestRunId}
        .snapshotOverride=${snapshot}
        .fullRunOverrides=${fullRuns}
      ></family-observability>
    `;
  }

  private _familySnapshotRuns(snapshot: FamilyObservabilitySnapshot): Run[] {
    return snapshot.runs.map((summary) => this._familySummaryToRun(summary, snapshot));
  }

  private _familySummaryToRun(
    summary: FamilyObservabilityRunSummary,
    snapshot: FamilyObservabilitySnapshot,
  ): Run {
    return {
      id: summary.runId,
      familyId: summary.familyId,
      parentRunId: summary.parentRunId,
      familyRootTicketOrPr: snapshot.familyRootTicketOrPr,
      lane: summary.lane,
      variant: summary.variant,
      flowType: summary.flowType,
      status: summary.status,
      project: summary.project,
      ticketOrPr: summary.ticketOrPr,
      slotId: summary.slotId,
      branch: summary.branch,
      taskFile: `tasks/${summary.runId}/TASK.md`,
      prNumber: summary.prNumber ?? undefined,
      steps: summary.steps.map((step) => ({
        name: step.stepName,
        status: step.status,
        detail: step.detail,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        durationMs: step.durationMs,
        outputs: {
          artifacts: step.artifacts,
          learnings: step.learnings,
          missingData: step.missingData,
        },
      })),
      decisions: summary.decisions ?? [],
      metrics: summary.metrics ?? { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      completedAt: summary.completedAt,
      humanGrade: summary.humanGrade,
      links: summary.links,
      summary: summary.summary ?? undefined,
    };
  }

  private renderIntelligenceIncidents() {
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();
    const summary = {
      total: 4,
      byActor: { 'auto-recovery': 3, 'auto-nudge': 1 },
      byOutcome: { applied: 3, skipped: 1 },
      metadata: { parseFailures: 0, shapeDriftFailures: 0 },
      records: [
        {
          id: 'inc-1',
          timestamp: iso(8 * 60 * 1000),
          decidedAt: iso(10 * 60 * 1000),
          runId: 'a4f9c2b14e6d',
          familyId: 'fam-8c2e9a01',
          project: 'example-mobile-farm',
          stepName: 'dispatch',
          actor: 'auto-recovery' as const,
          verdict: {
            category: 'env-drift' as const,
            patternId: 'tmux-stuck-prompt',
            confidence: 'high' as const,
            rationale: 'Worker idle 8min, last output ended with "Continue? (y/n)"',
          },
          guards: [
            { name: 'agent-idle', passed: true },
            { name: 'run-active', passed: true },
          ],
          outcome: 'applied' as const,
          appliedAction: { type: 'tmux.send' as const, stepName: 'dispatch', tmuxKeys: 'Enter' },
          followupOutcome: 'recovered' as const,
          tier: 'deterministic' as const,
          costUsd: 0,
          latencyMs: 142,
        },
        {
          id: 'inc-2',
          timestamp: iso(35 * 60 * 1000),
          decidedAt: iso(38 * 60 * 1000),
          runId: 'b1d7e2f398a0',
          familyId: 'fam-1f2d7c84',
          project: 'example-browser-farm',
          stepName: 'prepare',
          actor: 'auto-recovery' as const,
          verdict: {
            category: 'flake' as const,
            patternId: 'yarn-network-flake',
            confidence: 'medium' as const,
            rationale: 'yarn install hit transient ECONNRESET against npmjs.org',
          },
          guards: [{ name: 'attempt-cap', passed: true }],
          outcome: 'applied' as const,
          appliedAction: { type: 'run.replayStep' as const, stepName: 'prepare' },
          followupOutcome: 'failed-again' as const,
          tier: 'deterministic' as const,
          costUsd: 0,
          latencyMs: 78,
        },
        {
          id: 'inc-3',
          timestamp: iso(2 * 60 * 60 * 1000),
          decidedAt: iso(2 * 60 * 60 * 1000 + 90 * 1000),
          runId: 'c9a4108bff21',
          familyId: 'fam-44ab12c0',
          project: 'example-mobile-farm',
          stepName: 'monitor',
          actor: 'auto-recovery' as const,
          verdict: {
            category: 'timeout' as const,
            patternId: 'metro-port-blocked',
            confidence: 'high' as const,
            rationale: 'Metro port 8061 still bound to dead emulator-5560 process',
          },
          guards: [
            { name: 'attempt-cap', passed: true },
            { name: 'human-recent', passed: true },
          ],
          outcome: 'applied' as const,
          appliedAction: { type: 'slot.cleanupProcesses' as const },
          followupOutcome: 'recovered' as const,
          tier: 'deterministic' as const,
          costUsd: 0,
          latencyMs: 1180,
        },
        {
          id: 'inc-4',
          timestamp: iso(5 * 60 * 60 * 1000),
          decidedAt: iso(5 * 60 * 60 * 1000),
          runId: 'd7b21e009c4f',
          familyId: 'fam-99dd2017',
          project: 'example-mobile-farm',
          stepName: 'dispatch',
          actor: 'auto-recovery' as const,
          verdict: {
            category: 'infra' as const,
            patternId: 'ssh-host-unreachable',
            confidence: 'low' as const,
            rationale:
              'SSH to runner-a timed out 3x in 60s — not a known pattern, no allowlisted action',
          },
          guards: [{ name: 'allowlist', passed: false, reason: 'no matching action' }],
          outcome: 'skipped' as const,
          outcomeReason: 'no-allowlisted-action' as const,
          tier: 'deterministic' as const,
          costUsd: 0,
          latencyMs: 45,
        },
      ],
    };
    const liveSignals = [
      {
        slotId: 'runner-browser-3',
        type: 'idle' as const,
        message: 'Worker idle 8min, last output ended with "Continue? (y/n)"',
        nudgeSent: null,
        timestamp: iso(10 * 60 * 1000),
      },
      {
        slotId: 'mini-mme-1',
        type: 'stuck' as const,
        message: 'tmux pane unchanged for 12min',
        nudgeSent: iso(2 * 60 * 1000),
        timestamp: iso(12 * 60 * 1000),
      },
    ];
    return html`
      <intelligence-incidents-panel
        .injectedSummary=${summary}
        .injectedSignals=${liveSignals}
      ></intelligence-incidents-panel>
    `;
  }

  private renderIndex() {
    return html`
      ${DEV_ROUTE_GROUPS.map(
        (group) => html`
          <section class="index-section">
            <h2>${DEV_ROUTE_GROUP_LABELS[group]}</h2>
            <div class="index-grid">
              ${DEV_ROUTES.filter((r) => r.group === group).map(
                (r) => html`
                  <div
                    class="index-card"
                    @click=${() => {
                      location.hash = `dev/${r.route}`;
                    }}
                  >
                    <h3>${r.label}</h3>
                    <p>Test ${r.label.toLowerCase()} with mock data</p>
                  </div>
                `,
              )}
            </div>
          </section>
        `,
      )}
    `;
  }

  private renderSlotCards() {
    const slots = mockFleetSlots();
    const runs = mockPipelineRuns();
    const runMap = new Map(runs.filter((r) => r.slotId).map((r) => [r.slotId!, r]));
    const workingProgress = new Map([
      ['runner-local-mobile-1', mockStructuredProgress(3)],
      ['runner-a-example-1', mockStructuredProgress(6)],
    ]);
    return html`
      <p class="section-label">All lifecycle states (working slots show progress + linked runs)</p>
      <div class="card-grid">
        ${slots.map(
          (slot) =>
            html`<slot-card
              .slotData=${slot}
              .progress=${workingProgress.get(slot.slot)}
              .linkedRun=${runMap.get(slot.slot)}
            ></slot-card>`,
        )}
      </div>
    `;
  }

  private renderFleetMap() {
    // Inject mock runs into state so working slots have linked runs in fleet view
    this._updateMockFleet(mockFleetStatus());
    this._updateMockRuns(mockPipelineRuns());
    return html`
      <p class="section-label">
        Fleet canvas with 3 machines, 8 slots (working slots have linked runs)
      </p>
      <div class="fleet-container">
        <fleet-canvas></fleet-canvas>
      </div>
    `;
  }

  private renderSlotActions() {
    // Showcase the panel across lifecycle states. Each slot uses a typed
    // builder so SlotStatus shape changes surface here at compile time
    // (the previous `as unknown as SlotStatus` cast hid missing fields).
    const buildSlot = (overrides: Partial<SlotStatus> & { slot: string }): SlotStatus => ({
      machine: 'mock-mac',
      platform: 'darwin',
      project: 'demo-project',
      health: { device: '-', devserver: '-', cdp: '-' } as SlotHealth,
      branch: 'main',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'ready',
      phase: null,
      warm: true,
      taskId: null,
      taskFile: null,
      dispatchedAt: null,
      completedAt: null,
      runner: null,
      model: null,
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
      ...overrides,
    });
    const grid: Array<{ label: string; slot: SlotStatus }> = [
      { label: 'Idle on main (clean)', slot: buildSlot({ slot: 'demo-idle-clean' }) },
      {
        label: 'Idle on stale branch',
        slot: buildSlot({ slot: 'demo-idle-stale', branch: 'fix/some-old-pr' }),
      },
      {
        label: 'Busy / working',
        slot: buildSlot({
          slot: 'demo-busy',
          lifecycle: 'busy',
          phase: 'working',
          agent: 'working',
          branch: 'feat/new-thing',
          currentRunId: 'abc12345-...',
          currentFlowType: 'fix-bug',
          runner: 'claude',
          model: 'sonnet',
          currentTicketOrPr: 'EXAMPLE/repo#1234',
        }),
      },
      {
        label: 'Held / pr-watch',
        slot: buildSlot({
          slot: 'demo-held',
          lifecycle: 'held',
          phase: 'pr-watch',
          branch: 'feat/awaits-review',
          currentRunId: 'def67890-...',
          currentFlowType: 'pr-complete',
        }),
      },
      {
        label: 'Disabled',
        slot: buildSlot({
          slot: 'demo-disabled',
          lifecycle: 'disabled',
          enabled: false,
          dispatchable: false,
          branch: '',
        }),
      },
      {
        label: 'Ghost (missing from live pools)',
        slot: buildSlot({
          slot: 'demo-ghost',
          lifecycle: 'ready',
          dispatchable: false,
          missingFromPool: true,
        }),
      },
    ];

    return html`
      <p class="section-label">
        Slot Actions Panel — same component used in slot-view sidebar and the fleet "···" modal.
        Each card overrides slot status to demonstrate lifecycle-aware visibility & reasons. Buttons
        still hit the live gateway, so don't click them in dev unless the slotId matches a real
        slot.
      </p>
      <div
        style="display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
                   gap: ${spacing.md}; padding: ${spacing.md};"
      >
        ${grid.map(
          (g) => html`
            <div
              style="border: 1px solid #2a2a44; border-radius: 6px; background: ${colors.bgSurface};"
            >
              <div
                style="padding: 8px 12px; border-bottom: 1px solid #2a2a44;
                         font-family: ${fonts.mono}; font-size: ${fonts.sizeXs};
                         color: ${colors.textMuted};"
              >
                ${g.label}
              </div>
              <slot-actions-panel
                slot-id=${g.slot.slot}
                .slotOverride=${g.slot}
                hideOutput
              ></slot-actions-panel>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderFleetRefresh() {
    // Renders the bulk-refresh modal in its review state against the LIVE
    // fleet (no mock seeded). The modal classifies slots into Safe/Force/
    // Hidden using fleet.status + fleet.prSummary, so the same gateway that
    // serves the live UI populates the dev view too. Clicking "Refresh"
    // would invoke real slot.refresh calls, so don't unless you mean it.
    return html`
      <p class="section-label">
        Fleet Refresh modal — bulk "Refresh idle slots" surface. Hits the LIVE gateway: clicking
        Refresh runs real slot.refresh against the chosen slots. Use this route to iterate visual /
        interaction polish; for end-to-end refresh testing use #fleet and the toolbar button.
      </p>
      <div style="position: relative; min-height: 600px;">
        <fleet-refresh-modal open></fleet-refresh-modal>
      </div>
    `;
  }

  private renderTerminal() {
    const mockOutput = `$ bash scripts/check-slot.sh runner-local-mobile-1
[check] runner-local-mobile-1
  SSH:      LOCAL (macOS)
  Device:   sim:OK (playground-1)
  Metro:    OK (:8081)
  CDP:      Wallet (connected)
  Fixtures: OK (3/3)
  Branch:   fix/proj-2501
  Agent:    working (claude, sonnet)
  Task:     PROJ-2501 (dispatched 45m ago)

All checks passed.`;
    return html`
      <p class="section-label">Terminal output (mock)</p>
      <div class="terminal-placeholder">${mockOutput}</div>
    `;
  }

  private renderTerminalAttachment() {
    return html`
      <p class="section-label">Terminal image attachment states (paste + drag/drop)</p>
      <terminal-attachment-dev></terminal-attachment-dev>
    `;
  }

  private renderTerminalGrid() {
    return html`
      <p class="section-label">
        Terminal Grid (requires live gateway — connect to ws://localhost:7777 first)
      </p>
      <div
        style="height: calc(100vh - 160px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <terminal-split-view></terminal-split-view>
      </div>
    `;
  }

  private renderPRBoard() {
    const prs = mockPRList();
    return html`
      <p class="section-label">PR board with mixed CI states (${prs.length} PRs)</p>
      <div class="card-grid">${prs.map((pr) => html`<pr-card .pr=${pr}></pr-card>`)}</div>
    `;
  }

  private renderDecisions() {
    const decisions = mockDecisions();
    return html`
      <p class="section-label">Decision inbox (${decisions.length} pending)</p>
      <div class="card-grid">
        ${decisions.map(
          (d) => html`
            <div style="background: ${colors.bgCard}; border-radius: 8px; padding: 16px;">
              <strong style="color: ${colors.accent}">${d.title}</strong>
              <p style="color: ${colors.textMuted}; font-size: 12px; margin: 8px 0">
                ${d.description}
              </p>
              <div style="display: flex; gap: 8px; margin-top: 8px">
                ${d.actions.map(
                  (a) => html`
                    <button
                      style="padding: 4px 8px; border-radius: 4px; border: 1px solid ${a.style ===
                      'danger'
                        ? colors.statusFail
                        : a.style === 'primary'
                          ? colors.accent
                          : colors.textMuted}; background: transparent; color: ${a.style ===
                      'danger'
                        ? colors.statusFail
                        : a.style === 'primary'
                          ? colors.accent
                          : colors.textMuted}; cursor: pointer; font-family: inherit; font-size: 11px"
                    >
                      ${a.label}
                    </button>
                  `,
                )}
              </div>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderViolations() {
    const violations = mockViolations();
    return html`
      <p class="section-label">Violation feed (${violations.length} mock violations)</p>
      <div style="height: calc(100vh - 200px)">
        <violation-feed .violations=${violations}></violation-feed>
      </div>
    `;
  }

  private renderProgress() {
    const md = mockTaskMarkdown();
    const earlyProgress = mockStructuredProgress(2);
    const midProgress = mockStructuredProgress(5);
    const lateProgress = mockStructuredProgress(7);
    const doneProgress = mockStructuredProgress(8);
    return html`
      <p class="section-label">Flat progress tracker (no schema)</p>
      <progress-tracker .markdown=${md}></progress-tracker>
      <p class="section-label" style="margin-top: 24px">Flat progress (compact)</p>
      <progress-tracker .markdown=${md} compact></progress-tracker>

      <p class="section-label" style="margin-top: 32px">
        Structured progress — Early (2/8, Investigate)
      </p>
      <progress-tracker .markdown=${md} .structured=${earlyProgress}></progress-tracker>
      <p class="section-label" style="margin-top: 24px">
        Structured progress — Mid (5/8, Validate)
      </p>
      <progress-tracker .markdown=${md} .structured=${midProgress}></progress-tracker>
      <p class="section-label" style="margin-top: 24px">
        Structured progress — Late (7/8, Validate)
      </p>
      <progress-tracker .markdown=${md} .structured=${lateProgress}></progress-tracker>
      <p class="section-label" style="margin-top: 24px">Structured progress — Done (8/8)</p>
      <progress-tracker .markdown=${md} .structured=${doneProgress}></progress-tracker>

      <p class="section-label" style="margin-top: 32px">Structured progress — Compact variants</p>
      <div style="display: flex; flex-direction: column; gap: 12px">
        <progress-tracker .markdown=${md} .structured=${earlyProgress} compact></progress-tracker>
        <progress-tracker .markdown=${md} .structured=${midProgress} compact></progress-tracker>
        <progress-tracker .markdown=${md} .structured=${doneProgress} compact></progress-tracker>
      </div>
    `;
  }

  private renderDiff() {
    return html`
      <p class="section-label">Diff review (diff2html)</p>
      <div style="height: calc(100vh - 180px)">
        <diff-review .diff=${MOCK_UNIFIED_DIFF} filename="src/config.ts"></diff-review>
      </div>
    `;
  }

  private renderDiffViewerModal() {
    return html`
      <p class="section-label">Reusable diff viewer modal — file explorer + per-file diff</p>
      <button
        style="font-family:${fonts.mono}; font-size:12px; padding:8px 12px; border-radius:6px; border:1px solid ${colors.accent}; background:${colors.accent}22; color:${colors.accent}; cursor:pointer;"
        @click=${() => {
          this._diffViewerModalOpen = true;
        }}
      >
        Open diff modal (+120 -30 5 files)
      </button>
      <diff-viewer-modal
        .open=${this._diffViewerModalOpen}
        title="Mock package diff"
        .diffText=${MOCK_UNIFIED_DIFF}
        @diff-modal-close=${() => {
          this._diffViewerModalOpen = false;
        }}
      ></diff-viewer-modal>
    `;
  }

  private renderCodeEditor() {
    return html`
      <p class="section-label">Code editor (Monaco, changed lines highlighted)</p>
      <div style="height: calc(100vh - 180px)">
        <code-viewer
          .content=${MOCK_MODIFIED_SOURCE}
          .changedLines=${MOCK_CHANGED_LINES}
          filename="src/config.ts"
          language="typescript"
        ></code-viewer>
      </div>
    `;
  }

  private renderFileTree() {
    const entries = mockFileTree();
    return html`
      <p class="section-label">File tree (click dirs to expand, files to select)</p>
      <div style="display: flex; gap: 16px; height: calc(100vh - 200px)">
        <div
          style="width: 300px; background: ${colors.bgSurface}; border-radius: 8px; padding: ${spacing.md}; overflow: auto"
        >
          <file-tree
            .entries=${entries}
            @file-select=${(e: CustomEvent) => {
              this._selectedFile = e.detail.path;
            }}
          ></file-tree>
        </div>
        <div
          style="flex: 1; background: ${colors.bgCard}; border-radius: 8px; padding: ${spacing.lg}; font-family: ${fonts.mono}; font-size: ${fonts.sizeSm}; color: ${colors.textMuted}"
        >
          ${this._selectedFile
            ? html`<span style="color: ${colors.accent}">Selected:</span> ${this._selectedFile}`
            : 'Click a file to select it'}
        </div>
      </div>
    `;
  }

  private renderGitChanges() {
    const mock = mockGitChanges();
    return html`
      <p class="section-label">
        Git changes (${mock.changes.length} files, branch: ${mock.branch})
      </p>
      <div style="display: flex; gap: 16px">
        <div
          style="width: 400px; background: ${colors.bgSurface}; border-radius: 8px; overflow: hidden"
        >
          <git-changes
            .changes=${mock.changes}
            branch=${mock.branch}
            .ahead=${mock.ahead}
            .behind=${mock.behind}
            @change-select=${(e: CustomEvent) => {
              console.log('change-select', e.detail);
            }}
          ></git-changes>
        </div>
        <div
          style="width: 400px; background: ${colors.bgSurface}; border-radius: 8px; overflow: hidden"
        >
          <git-changes .changes=${[]} branch="main" .ahead=${0} .behind=${0}></git-changes>
        </div>
      </div>
    `;
  }

  private renderMetroLog() {
    // Seed with mock lines if empty
    if (this._metroLines.length === 0) {
      this._metroLines = [...mockMetroLines()];
    }
    // Start streaming simulation if not running
    if (!this._metroInterval) {
      const extraLines = [
        '[11:25:10] info  HMR update sent to client',
        '[11:25:15] info  BUNDLE  ./index.js (platform=ios, dev=true)',
        '[11:25:17] info  BUNDLE  completed in 1102ms',
        '[11:25:20] warn  Large bundle size: 2.4MB (consider code splitting)',
        '[11:25:25] info  HMR update sent to client',
        '[11:25:30] error SyntaxError: Unexpected token at line 42',
        '[11:25:35] info  BUNDLE  ./index.js (platform=android, dev=true)',
        '[11:25:38] info  BUNDLE  completed in 2801ms',
        '[11:25:40] info  HMR client connected',
        '[11:25:45] info  HMR update sent to client',
      ];
      let idx = 0;
      this._metroInterval = setInterval(() => {
        this._metroLines = [...this._metroLines, extraLines[idx % extraLines.length]];
        idx++;
      }, 2000);
    }
    return html`
      <p class="section-label">
        Metro log viewer (streaming simulation, ${this._metroLines.length} lines)
      </p>
      <div
        style="height: 300px; border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <metro-log-viewer
          .lines=${this._metroLines}
          @metro-clear=${() => {
            this._metroLines = [];
          }}
        ></metro-log-viewer>
      </div>
    `;
  }

  private renderWorkspace() {
    const fileEntries = mockFileTree();
    const gitData = mockGitChanges();
    const fileContents = mockWorkspaceFiles();
    const diffContents = mockWorkspaceDiffs();
    return html`
      <p class="section-label">Slot workspace (IDE-like layout)</p>
      <div
        style="height: calc(100vh - 160px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <slot-workspace
          slotId="runner-local-mobile-1"
          .fileEntries=${fileEntries}
          .gitData=${gitData}
          .fileContents=${fileContents}
          .diffContents=${diffContents}
        ></slot-workspace>
      </div>
    `;
  }

  private renderSlotView() {
    const fileEntries = mockFileTree();
    const gitData = mockGitChanges();
    const fileContents = mockWorkspaceFiles();
    const diffContents = mockWorkspaceDiffs();
    // Inject mock fleet + runs so slot-view renders the slot chrome and linked Run section.
    this._updateMockFleet(mockFleetStatus());
    this._updateMockRuns(mockPipelineRuns());
    return html`
      <p class="section-label">Slot view (unified: accordion sidebar + editor + terminal)</p>
      <div
        style="height: calc(100vh - 160px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <slot-view
          slotId="runner-local-mobile-1"
          .fileEntries=${fileEntries}
          .gitData=${gitData}
          .fileContents=${fileContents}
          .diffContents=${diffContents}
        ></slot-view>
      </div>
    `;
  }

  private renderSlotHistory() {
    return html`
      <p class="section-label">
        Slot history modal — copy-only recovery metadata for recent retained runs
      </p>
      <slot-history-modal
        slot-id="runner-local-mobile-1"
        .open=${true}
        .historyEntries=${mockSlotRunHistory()}
        @close=${() => {
          this.route = 'slot-view';
        }}
      ></slot-history-modal>
    `;
  }

  private renderSlotLoadRun() {
    const nowIso = (offsetMin: number) => new Date(Date.now() - offsetMin * 60_000).toISOString();
    const buildRun = (over: Partial<Run> & Pick<Run, 'id' | 'status'>): Run => ({
      familyId: over.id,
      lane: 'production',
      flowType: 'fix-bug',
      project: 'example-mobile',
      ticketOrPr: 'PROJ-0000',
      slotId: null,
      branch: 'fix/example',
      taskFile: null,
      steps: [],
      decisions: [],
      metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      createdAt: nowIso(120),
      updatedAt: nowIso(60),
      ...over,
    });
    const runs: Run[] = [
      buildRun({
        id: 'load-run-done-1',
        status: 'done',
        project: 'example-mobile',
        ticketOrPr: 'PROJ-2501',
        branch: 'fix/proj-2501-keychain',
        summary: 'Fix secure keychain unlock race on cold start',
        metrics: { nudgeCount: 1, model: 'sonnet', runner: 'claude' },
      }),
      buildRun({
        id: 'load-run-blocked-2',
        status: 'blocked',
        flowType: 'pr-complete',
        project: 'example-mobile',
        ticketOrPr: 'example-org/example-mobile#812',
        branch: 'fix/mobile-popup-flicker',
        summary: 'Resolve popup flicker after wallet unlock',
        metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex' },
      }),
      buildRun({
        id: 'load-run-failed-3',
        status: 'failed',
        flowType: 'review-pr',
        project: 'example-mobile',
        ticketOrPr: 'example-org/example-mobile#29373',
        branch: 'feature/perps-reuse-worker',
        summary: 'Review perps worker reuse during dispatch',
        metrics: { nudgeCount: 2, model: 'sonnet', runner: 'claude' },
      }),
      buildRun({
        id: 'load-run-monitoring-4',
        status: 'monitoring',
        project: 'example-mobile',
        ticketOrPr: 'PROJ-2610',
        branch: 'fix/proj-2610-balance',
        summary: 'Mid-pipeline run — Load disabled (still monitoring)',
        metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      }),
      buildRun({
        id: 'load-run-nobranch-5',
        status: 'cancelled',
        flowType: 'dev',
        project: 'example-mobile',
        ticketOrPr: 'MANUAL-000007',
        branch: null,
        summary: 'No-branch run — Load disabled (nothing to check out)',
        metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      }),
    ];
    return html`
      <p class="section-label">
        Load run modal — browse this project's runs and warm-switch this slot onto one
      </p>
      <slot-load-run-modal
        slot-id="dev-harness-slot"
        .project=${'example-mobile'}
        .open=${true}
        .runsOverride=${runs}
        @close=${() => {
          this.route = 'slot-view';
        }}
      ></slot-load-run-modal>
    `;
  }

  private renderRecipeProvenanceMatrix() {
    const scenarios = mockRecipeProvenanceScenarios();
    const activeScenario =
      scenarios.find((scenario) => scenario.id === this._recipeProvenanceScenarioId) ??
      scenarios[0];
    this._updateMockRuns([activeScenario.run]);

    return html`
      <p class="section-label">
        Recipe provenance matrix — slot-view should prefer selected live recipe-run artifacts over
        decision/final fallbacks
      </p>
      <div
        style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 16px;"
      >
        ${scenarios.map(
          (scenario) => html`
            <button
              style="text-align:left; border-radius: 8px; border: 1px solid ${scenario.id ===
              activeScenario.id
                ? colors.accent
                : colors.bgCardHover}; background: ${scenario.id === activeScenario.id
                ? `${colors.accent}12`
                : colors.bgCard}; color: ${colors.textPrimary}; padding: 12px; cursor: pointer; font-family: inherit;"
              @click=${() => {
                this._recipeProvenanceScenarioId = scenario.id;
              }}
            >
              <div
                style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: ${colors.textMuted}; margin-bottom: 6px;"
              >
                ${scenario.id}
              </div>
              <div style="font-weight: 700; margin-bottom: 6px;">${scenario.label}</div>
              <div style="font-size: 12px; color: ${colors.textSecondary}; line-height: 1.5;">
                ${scenario.expectation}
              </div>
            </button>
          `,
        )}
      </div>
      <div
        style="padding: 12px; border-radius: 8px; background: ${colors.bgCard}; color: ${colors.textSecondary}; margin-bottom: 16px;"
      >
        <strong style="color: ${colors.textPrimary};">Expected outcome:</strong>
        ${activeScenario.expectation}
      </div>
      <div
        style="height: calc(100vh - 260px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <slot-view
          slotId=${activeScenario.run.slotId ?? 'runner-local-mobile-1'}
          .fileEntries=${mockFileTree()}
          .gitData=${mockGitChanges()}
          .fileContents=${mockWorkspaceFiles()}
          .diffContents=${mockWorkspaceDiffs()}
        ></slot-view>
      </div>
    `;
  }

  private _stopMockSources() {
    this._mockSource1?.stop();
    this._mockSource2?.stop();
    this._mockSource1 = null;
    this._mockSource2 = null;
    this._feedRunning = false;
  }

  private _startMockSources() {
    this._stopMockSources();

    const feed1 = this.querySelector<StreamFeed>('#feed-small');
    const feed2 = this.querySelector<StreamFeed>('#feed-hd');

    this._mockSource1 = new MockH264Source({
      width: 360,
      height: 780,
      fps: this._feedFps,
      onChunk: (data, keyFrame, timestamp) => feed1?.feedChunk(data, keyFrame, timestamp),
    });
    this._mockSource2 = new MockH264Source({
      width: 720,
      height: 1560,
      fps: this._feedFps,
      onChunk: (data, keyFrame, timestamp) => feed2?.feedChunk(data, keyFrame, timestamp),
    });

    this._mockSource1.start();
    this._mockSource2.start();
    this._feedRunning = true;
  }

  private _handleFeedFpsChange(e: InputEvent) {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    this._feedFps = val;
    this._mockSource1?.setFps(val);
    this._mockSource2?.setFps(val);
  }

  private renderStreamFeed() {
    return html`
      <p class="section-label">Stream feed (H.264 via WebCodecs)</p>
      <div
        style="display: flex; gap: ${spacing.md}; align-items: center; margin-bottom: ${spacing.md}"
      >
        <button
          style="padding: 6px 16px; border-radius: 4px; border: 1px solid ${this._feedRunning
            ? colors.statusFail
            : colors.statusOk}; background: transparent; color: ${this._feedRunning
            ? colors.statusFail
            : colors.statusOk}; cursor: pointer; font-family: inherit; font-size: 12px"
          @click=${() => (this._feedRunning ? this._stopMockSources() : this._startMockSources())}
        >
          ${this._feedRunning ? 'Stop' : 'Start'}
        </button>
        <label
          style="color: ${colors.textMuted}; font-size: 11px; display: flex; align-items: center; gap: 6px"
        >
          FPS:
          <input
            type="range"
            min="1"
            max="30"
            .value=${String(this._feedFps)}
            @input=${this._handleFeedFpsChange}
            style="width: 120px"
          />
          <span style="color: ${colors.textSecondary}; min-width: 24px">${this._feedFps}</span>
        </label>
      </div>
      <div style="display: flex; gap: ${spacing.lg}; height: calc(100vh - 240px)">
        <div style="flex: 1; min-width: 0">
          <p class="section-label">360x780 (mobile)</p>
          <stream-feed
            id="feed-small"
            slotId="mock-small"
            style="height: calc(100% - 24px)"
          ></stream-feed>
        </div>
        <div style="flex: 1; min-width: 0">
          <p class="section-label">720x1560 (HD)</p>
          <stream-feed
            id="feed-hd"
            slotId="mock-hd"
            style="height: calc(100% - 24px)"
          ></stream-feed>
        </div>
      </div>
    `;
  }

  private renderPipeline() {
    const runs = mockPipelineRuns();
    const midMonitorProgress = mockStructuredProgress(3);
    const labels = [
      'Mid-monitor (fix-bug)',
      'Blocked with decision (fix-bug)',
      'Completed — full pipeline (fix-bug)',
      'Early-stage (review-pr)',
      'Failed (dev)',
      'Self-review running 7/11 (fix-bug)',
      'Self-review done w/ issues + retry (fix-bug)',
      'Publish-gate independent review loop (fix-bug)',
    ];
    return html`
      <p class="section-label">Run pipeline canvas (${runs.length} scenarios, 3 flow types)</p>
      ${runs.map(
        (run, i) => html`
          <p class="section-label" style="margin-top: 20px; color: ${colors.accent}">
            ${labels[i]}
          </p>
          <div
            style="background: ${colors.bgCard}; border-radius: 8px; padding: 12px; margin-bottom: 8px"
          >
            <run-pipeline
              .run=${run}
              .taskProgress=${i === 0 ? midMonitorProgress : undefined}
            ></run-pipeline>
          </div>
        `,
      )}
    `;
  }

  private renderPipelineMini() {
    const runs = mockPipelineRuns();
    return html`
      <div style="padding: 20px; display: flex; flex-direction: column; gap: 12px;">
        <h3 style="color: ${colors.textPrimary}">Mini Pipeline Bars</h3>
        ${runs.map(
          (r) => html`
            <div
              style="display: flex; align-items: center; gap: 12px; color: ${colors.textMuted}; font-size: 11px;"
            >
              <span style="width: 60px">${r.flowType}</span>
              <run-pipeline-mini
                .run=${r}
                .steps=${r.steps}
                .flowType=${r.flowType}
                style="flex: 1; max-width: 420px"
              ></run-pipeline-mini>
              <span>${r.status}</span>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderLinkedRunSummary() {
    const runs = mockPipelineRuns().slice(0, 3);
    return html`
      <div style="padding: 20px; display: grid; gap: 16px; max-width: 760px;">
        <h3 style="color: ${colors.textPrimary}; margin: 0">Linked Run Summary</h3>
        ${runs.map(
          (run, index) => html`
            <div style="display: grid; gap: 8px;">
              <div class="section-label">${index === 0 ? 'Expanded' : 'Compact'}</div>
              <linked-run-summary
                .run=${run}
                label=${index === 0 ? 'Current run' : 'Backlog run'}
                ?compact=${index > 0}
              ></linked-run-summary>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderFlowGraph() {
    return html`
      <p class="section-label">Flow graph — decision tree visualization (5 flows x 2 modes)</p>
      <div
        style="height: calc(100vh - 200px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <flow-graph showSelector></flow-graph>
      </div>
    `;
  }

  private renderRunDetail() {
    const runs = [...mockPipelineRuns(), ...mockRuns()];
    const run = runs.find((r) => r.id === 'pipe-mid-monitor') ?? runs[0];
    const packetPath = 'artifacts/interactive/dev-run-detail.packet.json';
    const bodyPath = 'artifacts/interactive/dev-run-detail.md';
    const packet: InteractiveOperatorPacket = {
      schema: INTERACTIVE_OPERATOR_PACKET_SCHEMA_V1,
      id: 'dev-run-detail-review',
      runId: run.id,
      title: 'Run detail packet',
      intent: 'review',
      summary: 'Rendered through run detail with a packet artifact.',
      body: { format: 'markdown', path: bodyPath },
      anchors: [{ id: 'packet-body', label: 'Packet body', artifactPath: bodyPath, line: 1 }],
      actions: [
        {
          id: 'copy',
          label: 'Copy summary',
          kind: 'copy',
          safety: 'read-only',
          payload: { text: 'Run detail packet copied.' },
        },
      ],
      createdAt: '2026-07-03T00:00:00.000Z',
    };
    const runWithPacket: Run = {
      ...run,
      flowType: 'review-pr',
      status: 'blocked',
      ticketOrPr: 'deeeed/farmslot#500',
      repeatReviewContext: {
        version: 1,
        chainId: 'prior-review-run',
        generation: 2,
        contextMode: 'reuse',
        priorRunId: 'prior-review-run',
        priorFamilyId: 'prior-review-family',
        repository: 'deeeed/farmslot',
        prNumber: 500,
        priorReviewedHeadSha: 'aaaaaaaaaaaaaaaa',
        currentHeadSha: 'bbbbbbbbbbbbbbbb',
        verdict: 'request changes',
        unresolvedFindings: [
          { file: 'services/gateway/src/index.ts', line: 42, description: 'Recheck this.' },
        ],
        artifactRefs: [{ path: 'artifacts/review.md', purpose: 'review' }],
        farmslotEvidenceRefs: [{ path: 'artifacts/recipe.json', purpose: 'recipe proof' }],
        reviewScope: 'incremental',
        validationDepth: 'static-code',
        sessionIntent: 'resume',
        session: {
          intent: 'resume',
          continuity: 'resumed',
          priorRunId: 'prior-review-run',
          priorSessionId: 'review-session-1',
          sessionId: 'review-session-1',
        },
        priorGenerations: [
          {
            chainId: 'prior-review-run',
            generation: 1,
            runId: 'prior-review-run',
            familyId: 'prior-review-family',
            repository: 'deeeed/farmslot',
            prNumber: 500,
            baseSha: '9999999999999999',
            headSha: 'aaaaaaaaaaaaaaaa',
            reviewScope: 'full',
            validationDepth: 'static-code',
            verdict: 'request changes',
            unresolvedCount: 1,
            artifactRefs: [{ path: 'artifacts/review.md', purpose: 'review' }],
            runner: 'codex',
            model: 'gpt-5.6-sol',
            createdAt: '2026-08-06T23:00:00.000Z',
            completedAt: '2026-08-06T23:30:00.000Z',
          },
        ],
      },
      decisions: [
        ...(run.decisions ?? []).map((decision) => ({
          ...decision,
          resolvedAt: decision.resolvedAt ?? '2026-08-06T23:59:00.000Z',
          resolvedAction: decision.resolvedAction ?? decision.actions[0]?.id ?? 'resolved',
        })),
        {
          id: 'dev-repeat-review-context',
          type: 'engine_review_continuation',
          title: 'deeeed/farmslot#500 — review continuation',
          description: 'A prior terminal review exists. Choose how to continue.',
          createdAt: '2026-08-07T00:00:00.000Z',
          actions: [
            {
              id: 'reuse-incremental-static',
              label: 'Continue — incremental static',
              style: 'primary',
            },
            {
              id: 'reuse-full-static',
              label: 'Load context — full static',
              style: 'secondary',
            },
            {
              id: 'fresh-full-static',
              label: 'Fresh context — full static',
              style: 'secondary',
            },
          ],
          payload: {
            kind: 'review_continuation',
            recommendedActionId: 'reuse-incremental-static',
            fullLiveAvailable: false,
            prior: {
              version: 1,
              chainId: 'prior-review-run',
              generation: 2,
              contextMode: 'reuse',
              priorRunId: 'prior-review-run',
              priorFamilyId: 'prior-review-family',
              repository: 'deeeed/farmslot',
              prNumber: 500,
              priorReviewedHeadSha: 'aaaaaaaaaaaaaaaa',
              currentHeadSha: 'bbbbbbbbbbbbbbbb',
              verdict: 'request changes',
              unresolvedFindings: [
                { file: 'services/gateway/src/index.ts', line: 42, description: 'Recheck this.' },
              ],
              artifactRefs: [{ path: 'artifacts/review.md', purpose: 'review' }],
              farmslotEvidenceRefs: [{ path: 'artifacts/recipe.json', purpose: 'recipe proof' }],
              reviewScope: 'incremental',
              validationDepth: 'static-code',
              sessionIntent: 'resume',
              priorGenerations: [],
            },
          },
        },
      ],
      steps: [
        ...(run.steps ?? []),
        {
          name: 'interactive-packets',
          status: 'done',
          outputs: {
            artifacts: [
              {
                path: packetPath,
                purpose: 'interactive-packet',
                type: 'interactive-packet',
                mimeType: 'application/vnd.farmslot.operator-packet+json',
              },
            ],
          },
        },
      ],
    };
    this._updateMockRuns(
      runs.map((candidate) => (candidate.id === run.id ? runWithPacket : candidate)),
    );
    const continuationDecision = runWithPacket.decisions.at(-1)!;
    updateDecisions([
      {
        id: continuationDecision.id,
        type: continuationDecision.type,
        slotId: runWithPacket.slotId,
        title: continuationDecision.title,
        description: continuationDecision.description,
        context: {
          runId: runWithPacket.id,
          project: runWithPacket.project,
          flowType: runWithPacket.flowType,
          ticketOrPr: runWithPacket.ticketOrPr,
        },
        actions: continuationDecision.actions,
        createdAt: continuationDecision.createdAt,
        payload: continuationDecision.payload,
      },
    ]);
    const artifactTextLoader = async (path: string): Promise<string> => {
      if (path === packetPath) return JSON.stringify(packet);
      if (path === bodyPath) {
        return [
          '## Run detail packet body',
          '',
          '- Rendered from a run step artifact.',
          '- Uses the same packet panel as production run detail.',
        ].join('\n');
      }
      throw new Error(`Missing mock artifact: ${path}`);
    };
    return html`
      <p class="section-label">Run detail (repeat-review continuation + operator packet)</p>
      <div
        style="height: calc(100vh - 200px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <run-detail
          .runId=${runWithPacket.id}
          .mockRun=${runWithPacket}
          .mockArtifactTextLoader=${artifactTextLoader}
          mock-data
        ></run-detail>
      </div>
    `;
  }

  private renderRunTagEditor() {
    return html`
      <p class="section-label">Run tag editor states</p>
      <div class="card-grid">
        <div class="index-card">
          <h3>Tagged run</h3>
          <run-tag-editor
            .tags=${['demo', 'onboarding']}
            .saveTags=${async () => undefined}
            .filterTag=${(tag: string) => {
              location.hash = `runs?tag=${encodeURIComponent(tag)}`;
            }}
          ></run-tag-editor>
        </div>
        <div class="index-card">
          <h3>Empty run</h3>
          <run-tag-editor .tags=${[]} .saveTags=${async () => undefined}></run-tag-editor>
        </div>
        <div class="index-card">
          <h3>Read-only</h3>
          <run-tag-editor .tags=${['release-demo']} .filterTag=${() => undefined}></run-tag-editor>
        </div>
        <div class="index-card">
          <h3>Disabled actions</h3>
          <run-tag-editor
            .tags=${['blocked']}
            .disabled=${true}
            .saveTags=${async () => undefined}
          ></run-tag-editor>
        </div>
      </div>
    `;
  }

  private renderRuns() {
    const runs = mockRuns();
    // Inject mock runs into state so run-list picks them up
    this._updateMockRuns(runs);
    return html`
      <p class="section-label">Run list (${runs.length} mock runs)</p>
      <div
        style="height: calc(100vh - 200px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <run-list></run-list>
      </div>
    `;
  }

  private renderReviewWorkspace() {
    const mockPayload: ReviewGatePayload = {
      kind: 'review',
      prNumber: 28013,
      repo: 'AcmeOrg/acme-mobile',
      recommendation: 'APPROVE',
      reviewMd: `## Summary\n\nThe PR correctly implements the flipSize toggle for the trading interface. Code quality is good with proper error handling.\n\n## AC Validation\n\n- [x] Toggle button switches between base/quote denomination\n- [x] Price display updates correctly\n- [x] No regression in existing trading flows\n\n## Code Quality\n\nWell-structured changes. The \`flipSize\` state is properly threaded through the component tree.\n\n## Risk Assessment\n\n**Low risk.** Changes are isolated to the trading UI with no backend modifications.\n\n## Recommended Action\n\nAPPROVE — clean implementation, all AC met.`,
      lineComments: [
        {
          path: 'app/components/TradingService.ts',
          line: 1958,
          body: '`flipSize` is still initialized as `false` but the default in the Figma spec shows it as `true`. Consider matching the design spec default.',
          severity: 'nitpick',
        },
        {
          path: 'app/components/TradingService.ts',
          line: 2010,
          body: 'This function could use a guard clause for `undefined` price values to avoid NaN display in edge cases.',
          severity: 'suggestion',
        },
        {
          path: 'app/components/ui/PriceDisplay.tsx',
          line: 42,
          body: 'Good use of `useMemo` here to avoid recalculating on every render.',
          severity: 'comment',
        },
      ],
      reviewSnapshot: {
        source: 'github-pr',
        baseRef: 'main',
        baseSha: '6d90188f9f1c4a72b2d1f7a8a8bcb77a210f0050',
        headRef: 'fix/proj-2418-flip-size',
        headSha: 'abc1234f9f1c4a72b2d1f7a8a8bcb77a210f0050',
        diffPath: 'inputs/diff.txt',
        diffHash: 'mock-diff-sha256',
        diffStat: { files: 5, additions: 120, deletions: 30 },
        capturedAt: new Date().toISOString(),
      },
      reviewInputArtifactPaths: ['inputs/commit.json', 'inputs/diff.txt', 'inputs/diff-stat.json'],
      artifactManifest: [
        { path: 'inputs/diff.txt', purpose: 'input-diff', sizeBytes: 4820 },
        { path: 'artifacts/before-trading-ui.png', purpose: 'screenshot', sizeBytes: 145200 },
        { path: 'artifacts/after-trading-ui.png', purpose: 'screenshot', sizeBytes: 152800 },
        { path: 'artifacts/evidence-flip-toggle.png', purpose: 'screenshot', sizeBytes: 98400 },
        { path: 'artifacts/review.mp4', purpose: 'video', sizeBytes: 2340000 },
      ],
      artifactUrls: {
        'before-trading-ui.png':
          'https://raw.githubusercontent.com/AcmeOrg/artifacts/main/reviews/28013/before-trading-ui.png',
        'after-trading-ui.png':
          'https://raw.githubusercontent.com/AcmeOrg/artifacts/main/reviews/28013/after-trading-ui.png',
        'evidence-flip-toggle.png':
          'https://raw.githubusercontent.com/AcmeOrg/artifacts/main/reviews/28013/evidence-flip-toggle.png',
        'review.mp4':
          'https://raw.githubusercontent.com/AcmeOrg/artifacts/main/reviews/28013/review.mp4',
        'inputs/diff.txt': `data:text/plain;charset=utf-8,${encodeURIComponent(MOCK_UNIFIED_DIFF)}`,
        'diff.txt': `data:text/plain;charset=utf-8,${encodeURIComponent(MOCK_UNIFIED_DIFF)}`,
      },
      evidenceMarkdown:
        '### Trading UI\n| Before | After |\n|---|---|\n| <img src="https://raw.githubusercontent.com/AcmeOrg/artifacts/main/reviews/28013/before-trading-ui.png" width="360" /> | <img src="https://raw.githubusercontent.com/AcmeOrg/artifacts/main/reviews/28013/after-trading-ui.png" width="360" /> |',
      recipeJson: JSON.stringify({
        workflow: {
          entry: 'checkout',
          nodes: {
            checkout: { action: 'git checkout branch', next: 'install' },
            install: { action: 'yarn install', next: 'build' },
            build: {
              action: 'yarn build',
              assertions: [{ type: 'exit_code', expected: 0 }],
              next: 'review',
            },
            review: { action: 'review PR diff', next: 'PASS' },
          },
        },
      }),
      recipeQualityArtifact: {
        version: 1,
        verdict: 'warn',
        compact: {
          verdict: 'WARN',
          reasons: [
            'Recipe quality is reviewable, but one AC is still missing strong proof.',
            'The existing screenshots prove the main UI change but not the regression claim.',
          ],
          better_version_guidance: [
            'Add one explicit regression-proof node for the unchanged trading flow.',
            'Tighten the weak screenshot so the denominated value is fully visible.',
          ],
        },
        dimensions: {},
        structural_findings: [],
        contextual_findings: [],
        suggested_recipe_delta: [],
        training_fields: {
          project: 'acme-mobile-farm',
          flow_type: 'review-pr',
          proof_mode: 'mixed',
        },
        meta: {
          producer: 'worker',
          fallback_used: false,
          legacy_task: false,
          artifact_required: true,
          source_signals: ['recipe-quality.json'],
        },
      },
      workerLearnings: `## Learnings\n\n- **Flip toggle state**: The \`flipSize\` prop must be initialized via \`usePersistedState\` not \`useState\` — otherwise it resets on navigation.\n- **Price formatting**: \`roundToSignificantFigures()\` early-returns for integers, so BTC prices display correctly without decimals.\n- **CDP timing**: After wallet unlock, the \`__AGENTIC__\` global takes 5-10s to appear. Poll with 1s interval.`,
      qualityReport: {
        acVerdicts: [
          {
            ac: 'Toggle button switches between base/quote denomination',
            verdict: 'RELEVANT_HIGH' as const,
            reasoning: 'Screenshot shows toggle in both states with correct labels',
          },
          {
            ac: 'Price display updates correctly',
            verdict: 'RELEVANT_LOW' as const,
            reasoning: 'Screenshot shows price but denominated value is partially obscured',
          },
          {
            ac: 'No regression in existing trading flows',
            verdict: 'MISSING' as const,
            reasoning: 'No evidence captured for regression testing of existing flows',
          },
        ],
        overallScore: 67,
        overrides: [],
      },
    };
    const mockDecision: RunDecision = {
      id: 'mock-review-decision-1',
      type: 'engine_review_posting',
      title: 'Run abc12345 — review posting',
      description: 'APPROVE with 3 comments',
      actions: [
        { id: 'post', label: 'Post to PR', style: 'primary' },
        { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
      ],
      createdAt: new Date().toISOString(),
      payload: mockPayload,
    };
    return html`
      <p class="section-label">Review workspace (mock APPROVE with 3 line comments)</p>
      <div
        style="height: calc(100vh - 160px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <review-workspace
          runId="mock-run-1"
          slotId="runner-browser-1"
          .decision=${mockDecision}
        ></review-workspace>
      </div>
    `;
  }

  private renderReadyWorkspace() {
    const mockPayload: ReadyGatePayload = {
      kind: 'ready',
      prNumber: 28099,
      repo: 'AcmeOrg/acme-mobile',
      diffStat: { files: 5, additions: 120, deletions: 30 },
      workerReport: `## Summary\n\nFixed the balance display rounding issue reported in PROJ-2418. The \`roundToSignificantFigures\` function now correctly handles integer values without adding unnecessary decimal places.\n\n## Changes\n\n- Modified \`formatBalance.ts\` to early-return for integer values\n- Added test cases for BTC price formatting\n- Updated snapshot tests\n\n## Testing\n\n- Verified BTC balance shows "55,123" not "55,123.0"\n- Verified ETH balance still shows "1.2345"\n- All existing tests pass`,
      branch: 'fix/proj-2418',
      slotId: 'runner-local-mobile-1',
      inputSnapshot: {
        ticketData: {
          source: 'jira',
          issueType: 'Bug',
          title: 'BTC balance displays unnecessary decimal',
          description:
            'Wallet portfolio balances should not render a trailing `.0` when the source amount is already an integer. This was reported by QA on the portfolio screen.',
          acceptanceCriteria: [
            'BTC balance displays as "55,123" with no trailing decimal.',
            'ETH balance with fractional precision still renders correctly.',
          ],
          affectedArea: 'Portfolio balance display',
          stepsToReproduce: [
            'Open portfolio with a whole-number BTC balance.',
            'Observe the rendered balance row.',
          ],
          screenshots: [],
          labels: ['team-wallet', 'regression'],
          jiraKey: 'PROJ-2418',
          comments: [
            'QA (2026-05-12): Reproduces on staging with BTC fixture wallet.',
            'Arthur (2026-05-12): Keep this local-first until the recipe passes.',
          ],
        },
        initialContext:
          'Please preserve existing ETH precision behavior. Do not change Mixpanel events.',
        checklist: ['Add focused formatter test', 'Capture before/after evidence'],
        taskFile: 'temp/tasks/fix-bug/proj-2418/TASK.md',
        taskPrompt:
          '# TASK\n\nFix PROJ-2418. Read the Jira context above, implement the balance formatting fix, validate with tests and recipe evidence.',
      },
      recipeJson: JSON.stringify({
        name: 'balance-rounding-fix',
        steps: [
          { action: 'navigate', target: 'portfolio' },
          { action: 'assert', selector: '.balance-value', contains: '55,123' },
          { action: 'screenshot', name: 'btc-balance' },
        ],
      }),
      recipeQualityArtifact: {
        version: 1,
        verdict: 'pass',
        compact: {
          verdict: 'PASS',
          reasons: [
            'Recipe uses a narrow assertion for the real rounding fix.',
            'Proof is compact and matches the claimed BTC balance behavior.',
          ],
          better_version_guidance: [],
        },
        dimensions: {},
        structural_findings: [],
        contextual_findings: [],
        suggested_recipe_delta: [],
        training_fields: { project: 'acme-mobile-farm', flow_type: 'fix-bug', proof_mode: 'mixed' },
        meta: {
          producer: 'worker',
          fallback_used: false,
          legacy_task: false,
          artifact_required: true,
          source_signals: ['recipe-quality.json'],
        },
      },
      qualityReport: {
        acVerdicts: [
          {
            ac: 'BTC balance displays as "55,123" (no unnecessary decimals)',
            verdict: 'RELEVANT_HIGH',
            reasoning: 'After screenshot and focused assertion prove the formatting fix.',
          },
          {
            ac: 'ETH balance with real decimals still shows correctly',
            verdict: 'RELEVANT_LOW',
            reasoning: 'Covered by report text but missing direct screenshot evidence.',
          },
          {
            ac: 'No regression in other balance display scenarios',
            verdict: 'MISSING',
            reasoning: 'Regression claim has no separate artifact yet.',
          },
        ],
        overallScore: 72,
        overrides: [],
      },
      artifactManifest: [
        { path: 'report.md', purpose: 'report', sizeBytes: 1234 },
        { path: 'recipe.json', purpose: 'recipe', sizeBytes: 456 },
        { path: 'artifacts/diff.txt', purpose: 'diff', sizeBytes: 4820 },
        { path: 'before-btc-balance.png', purpose: 'screenshot-before', sizeBytes: 80000 },
        { path: 'after-btc-balance.png', purpose: 'screenshot-after', sizeBytes: 85000 },
        { path: 'after-btc-balance.mp4', purpose: 'video-after', sizeBytes: 2500000 },
        { path: 'artifacts/independent-review-1.md', purpose: 'review', sizeBytes: 1420 },
        { path: 'artifacts/independent-review-2.md', purpose: 'review', sizeBytes: 980 },
        { path: 'pr-description.md', purpose: 'pr-description', sizeBytes: 890 },
      ],
      prPackage: {
        id: 'pkg-def67890',
        packageHash: 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890',
        artifactPath: 'artifacts/pr-package.json',
        branch: 'fix/proj-2418',
        remoteBranchRef: 'origin/fix/proj-2418',
        headSha: 'abc123def4567890',
        diffStat: { files: 4, additions: 128, deletions: 12 },
        draftTitle: 'fix: correct BTC balance formatting',
        draftBody: [
          '## Summary',
          'Fix BTC balance formatting so integer balances no longer render a trailing decimal.',
          '',
          '## Validation',
          '- Recipe passed',
          '- Typecheck passed',
          '- Independent self-review loops: 2',
          '',
          '## Visuals',
          '- Before: BTC rendered with an unnecessary decimal',
          '- After: BTC renders as `55,123`',
        ].join('\n'),
        evidenceManifest: [
          { path: 'before-btc-balance.png', purpose: 'screenshot-before', sizeBytes: 80000 },
          { path: 'after-btc-balance.png', purpose: 'screenshot-after', sizeBytes: 85000 },
          { path: 'after-btc-balance.mp4', purpose: 'video-after', sizeBytes: 2500000 },
        ],
        selectedEvidenceKeys: [
          'before-btc-balance.png',
          'after-btc-balance.png',
          'after-btc-balance.mp4',
        ],
        validationSummaryPath: 'artifacts/report.md',
        validationSummaryHash: 'valhash',
        reviewArtifactIds: [
          'artifacts/independent-review-1.json',
          'artifacts/independent-review-2.json',
        ],
        dispatchMode: 'autonomous',
        gatePolicy: {
          owner: 'human',
          dispatchMode: 'autonomous',
          publishAuthority: 'human',
          reason: 'v1 autonomous fix-bug runs still require human publication approval',
        },
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
        createdAt: new Date().toISOString(),
      },
      reviewDepth: {
        minimumIndependentReviews: 1,
        requireCrossRunner: true,
        extraLoopsRequested: 1,
        requestedBy: 'human-gate',
      },
      independentReviews: [
        {
          id: 'independent-review-1',
          runner: 'claude',
          model: 'sonnet',
          crossRunner: false,
          loopNumber: 1,
          verdict: 'issues',
          unresolvedCount: 2,
          issues: [
            {
              file: 'src/formatBalance.ts',
              line: 42,
              description: 'Integer balances still render a redundant decimal suffix.',
            },
            {
              file: 'src/formatBalance.test.ts',
              line: 18,
              description: 'The regression case is missing from the focused formatter suite.',
            },
          ],
          reviewSnapshot: {
            source: 'local-git',
            baseRef: 'main',
            baseSha: '6d90188f9f1c4a72b2d1f7a8a8bcb77a210f0050',
            headRef: 'fix/proj-2418',
            headSha: '9f8e7d6c5b4a3a21000000000000000000000000',
            diffPath: 'artifacts/independent-review-1/review-loop-1/review.diff',
            diffHash: 'review-loop-1-hash',
            diffStat: { files: 5, additions: 118, deletions: 30 },
            capturedAt: new Date().toISOString(),
          },
          taskProgressArtifactPath:
            'tasks/fix-bug/proj-2418/artifacts/independent-review-1/review-loop-1/self-review.md',
          startedAt: new Date(Date.now() - 12 * 60000).toISOString(),
          completedAt: new Date(Date.now() - 9 * 60000).toISOString(),
          artifactPaths: [
            'artifacts/independent-review-1.json',
            'artifacts/independent-review-1.md',
            'artifacts/independent-review-1/review-loop-1/review.diff',
            'artifacts/independent-review-1/review-loop-1/self-review.md',
          ],
        },
        {
          id: 'independent-review-2',
          runner: 'codex',
          model: 'gpt-5.5',
          crossRunner: true,
          loopNumber: 2,
          verdict: 'pass',
          unresolvedCount: 0,
          attempts: [
            {
              loopNumber: 1,
              verdict: 'issues',
              unresolvedCount: 2,
              issues: [
                {
                  file: 'src/formatBalance.ts',
                  line: 42,
                  description: 'Integer balances still render a redundant decimal suffix.',
                },
                {
                  file: 'src/formatBalance.test.ts',
                  line: 18,
                  description: 'The focused regression case is missing.',
                },
              ],
              validationDepth: 'static-code',
              reviewSnapshot: {
                source: 'local-git',
                baseRef: 'main',
                baseSha: '6d90188f9f1c4a72b2d1f7a8a8bcb77a210f0050',
                headRef: 'fix/proj-2418',
                headSha: '9f8e7d6c5b4a3a21000000000000000000000000',
                capturedAt: new Date().toISOString(),
              },
            },
            {
              loopNumber: 2,
              verdict: 'pass',
              unresolvedCount: 0,
              validationDepth: 'static-code',
              fixDelta: {
                source: 'local-git',
                baseSha: '9f8e7d6c5b4a3a21000000000000000000000000',
                headSha: 'a1b2c3d4e5f6a7b8000000000000000000000000',
                fixBaseSha: '9f8e7d6c5b4a3a21000000000000000000000000',
                fixHeadSha: 'a1b2c3d4e5f6a7b8000000000000000000000000',
                diffStat: { files: 2, additions: 14, deletions: 4 },
                capturedAt: new Date().toISOString(),
              },
              reviewSnapshot: {
                source: 'local-git',
                baseRef: 'main',
                baseSha: '6d90188f9f1c4a72b2d1f7a8a8bcb77a210f0050',
                headRef: 'fix/proj-2418',
                headSha: 'a1b2c3d4e5f6a7b8000000000000000000000000',
                capturedAt: new Date().toISOString(),
              },
            },
          ],
          reviewSnapshot: {
            source: 'local-git',
            baseRef: 'main',
            baseSha: '6d90188f9f1c4a72b2d1f7a8a8bcb77a210f0050',
            headRef: 'fix/proj-2418',
            headSha: 'a1b2c3d4e5f6a7b8000000000000000000000000',
            diffPath: 'artifacts/independent-review-2/review-loop-1/review.diff',
            diffHash: 'review-loop-2-hash',
            diffStat: { files: 5, additions: 120, deletions: 30 },
            capturedAt: new Date().toISOString(),
          },
          fixDelta: {
            source: 'local-git',
            baseSha: '9f8e7d6c5b4a3a21000000000000000000000000',
            headSha: 'a1b2c3d4e5f6a7b8000000000000000000000000',
            fixBaseSha: '9f8e7d6c5b4a3a21000000000000000000000000',
            fixHeadSha: 'a1b2c3d4e5f6a7b8000000000000000000000000',
            diffPath: 'artifacts/independent-review-2/review-loop-2/fix-delta.diff',
            diffHash: 'fix-delta-hash',
            diffStat: { files: 2, additions: 14, deletions: 4 },
            capturedAt: new Date().toISOString(),
          },
          taskProgressArtifactPath:
            'tasks/fix-bug/proj-2418/artifacts/independent-review-2/review-loop-2/self-review.md',
          startedAt: new Date(Date.now() - 8 * 60000).toISOString(),
          completedAt: new Date(Date.now() - 3 * 60000).toISOString(),
          artifactPaths: [
            'artifacts/independent-review-2.json',
            'artifacts/independent-review-2.md',
            'artifacts/independent-review-2/review-loop-1/review.diff',
            'artifacts/independent-review-2/review-loop-2/fix-delta.diff',
            'artifacts/independent-review-2/review-loop-2/self-review.md',
          ],
        },
      ],
      gatePolicy: {
        owner: 'human',
        dispatchMode: 'autonomous',
        publishAuthority: 'human',
        reason: 'v1 autonomous fix-bug runs still require human publication approval',
      },
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      selfReviewVerdict: 'pass',
      selfReviewSummary:
        'Loop 1 found two issues: missing integer formatter regression coverage and stale snapshot copy. The worker added focused formatter tests, updated snapshots, then loop 2 passed the independent review with zero unresolved findings.',
      workerLearnings: `- Investigation took ~15min, fix was 2 lines. Most time spent finding the right formatter function across 4 files.\n- TASK.md step 5 ("validate with recipe") was unclear — no recipe file existed yet at that point.\n- Got stuck on snapshot test failures — updating snapshots via \`yarn test -u\` unblocked.\n- Knowing that \`formatBalance.ts\` delegates to \`roundToSignificantFigures\` would have saved investigation time.`,
      ciChecks: [
        { name: 'lint', status: 'completed', conclusion: 'success' },
        { name: 'tsc', status: 'completed', conclusion: 'success' },
        { name: 'jest', status: 'completed', conclusion: 'success' },
        { name: 'detox', status: 'completed', conclusion: 'failure' },
      ],
      acceptanceCriteria: [
        'BTC balance displays as "55,123" (no unnecessary decimals)',
        'ETH balance with real decimals still shows correctly (e.g. "1.2345")',
        'No regression in other balance display scenarios',
      ],
    };
    const mockDecision: RunDecision = {
      id: 'mock-ready-decision-1',
      type: 'engine_human_gate',
      title: 'Run def67890 — ready check',
      description: 'fix-bug run completed',
      actions: [
        { id: 'approve-publish', label: 'Approve Publish', style: 'primary' },
        { id: 'hold', label: 'Hold', style: 'secondary' },
        { id: 'send-feedback', label: 'Send Feedback', style: 'secondary' },
        { id: 'request-extra-review', label: 'Request Independent Review', style: 'secondary' },
        {
          id: 'request-external-review',
          label: 'Request Independent Review (runner diversity)',
          style: 'secondary',
        },
      ],
      createdAt: new Date().toISOString(),
      payload: mockPayload,
    };
    return html`
      <p class="section-label">
        Ready workspace (mock fix-bug completion with diff + recipe + artifacts)
      </p>
      <div
        style="height: calc(100vh - 160px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <ready-workspace
          runId="mock-run-2"
          .decision=${mockDecision}
          mock-data
          slotId="runner-local-mobile-1"
          branch="fix/proj-2418"
          runner="claude"
        ></ready-workspace>
      </div>
    `;
  }

  private renderStepInspector() {
    const gradeStep = {
      name: 'grade',
      status: 'done' as const,
      startedAt: '2026-03-27T10:00:00Z',
      completedAt: '2026-03-27T10:00:12Z',
      durationMs: 12000,
      inputs: { ticketOrPr: 'PROJ-2483' },
      outputs: {
        difficulty: 'medium',
        modelRecommendation: 'sonnet',
        score: 5,
        source: 'jira',
        title: 'Fix crash on wallet connect',
      },
    };
    const finalizeStep = {
      name: 'finalize',
      status: 'done' as const,
      startedAt: '2026-03-27T12:45:00Z',
      completedAt: '2026-03-27T12:45:08Z',
      durationMs: 8000,
      inputs: { taskDir: 'tasks/fix/proj-2483-0327-1200' },
      outputs: {
        commentPosted: true,
        metricsSavedToTask: true,
        costEstimate: 2.47,
        model: 'claude-sonnet-4-6',
        session: {
          inputTokens: 45200,
          outputTokens: 12800,
          totalTokens: 58000,
          costUsd: 2.47,
          model: 'claude-sonnet-4-6',
          sessionDurationMs: 2400000,
          numCompactions: 3,
          numTurns: 42,
        },
        artifactPath: 'artifacts/session-metrics.json',
        artifacts: [
          { path: 'artifacts/session-metrics.json', purpose: 'report', sizeBytes: 1240 },
          { path: 'artifacts/fix-diff.txt', purpose: 'diff', sizeBytes: 4800 },
        ],
      },
    };
    const failedStep = {
      name: 'prepare',
      status: 'failed' as const,
      detail: 'yarn install failed: lockfile conflict',
      outputs: {
        failedCommand: 'yarn install --immutable',
        failedLogPath: '/tmp/farmslot-dev.log',
      },
    };
    const mockRun = {
      id: 'dev-failed-run',
      ticketOrPr: 'AUD-42',
      flowType: 'dev',
      slotId: 'runner-local-audiolab-1',
      metrics: { costEstimate: 2.47, model: 'claude-sonnet-4-6' },
    } as any;
    return html`<div
      style="padding: 20px; max-width: 520px; display: flex; flex-direction: column; gap: 24px;"
    >
      <div>
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">Step Inspector — grade</h3>
        <step-inspector .step=${gradeStep}></step-inspector>
      </div>
      <div>
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">
          Step Inspector — finalize (cost summary)
        </h3>
        <step-inspector .step=${finalizeStep} .run=${mockRun}></step-inspector>
      </div>
      <div>
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">
          Step Inspector — failed prepare
        </h3>
        <step-inspector .step=${failedStep} .run=${mockRun}></step-inspector>
      </div>
    </div>`;
  }

  private renderStepArtifacts() {
    const withArtifacts = {
      stepName: 'complete',
      status: 'done' as const,
      durationMs: 27000,
      detail: 'Pipeline finished — diff captured, retrospective scheduled.',
      artifacts: [
        {
          runId: 'r1',
          familyId: 'f1',
          stepName: 'complete',
          path: 'artifacts/recipe.json',
          purpose: 'recipe',
          sizeBytes: 7282,
          source: 'step-output' as const,
        },
        {
          runId: 'r1',
          familyId: 'f1',
          stepName: 'complete',
          path: 'artifacts/comments-triage.json',
          purpose: 'triage',
          sizeBytes: 2183,
          source: 'step-output' as const,
        },
        {
          runId: 'r1',
          familyId: 'f1',
          stepName: 'complete',
          path: 'artifacts/screenshots/after-ac1.png',
          purpose: 'screenshot',
          sizeBytes: 52221,
          source: 'artifact-manifest' as const,
        },
      ],
      learnings: [],
      missingData: [],
    };
    const empty = {
      stepName: 'finalize',
      status: 'done' as const,
      durationMs: 1200,
      artifacts: [],
      learnings: [],
      missingData: [],
    };
    const withLearningsAndMissing = {
      stepName: 'self-review',
      status: 'done' as const,
      durationMs: 14000,
      detail: 'verdict=issues',
      artifacts: [
        {
          runId: 'r1',
          familyId: 'f1',
          stepName: 'self-review',
          path: 'artifacts/review-feedback.md',
          purpose: 'review',
          sizeBytes: 2160,
          source: 'step-output' as const,
        },
      ],
      learnings: [
        {
          runId: 'r1',
          stepName: 'self-review',
          source: 'step-output' as const,
          title: 'Edge case missed',
          summary: 'Empty-list guard absent in ActivityFeed.',
        },
      ],
      missingData: ['self-review-details'],
    };
    const onClick = (e: CustomEvent<{ artifacts: unknown[]; index: number }>) => {
      console.log('[dev] step-artifact-click', e.detail);
    };
    return html`<div
      style="padding: 20px; max-width: 720px; display: flex; flex-direction: column; gap: 24px;"
    >
      <div>
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">With artifacts</h3>
        <step-artifacts
          .stepName=${withArtifacts.stepName}
          .status=${withArtifacts.status}
          .durationMs=${withArtifacts.durationMs}
          .detail=${withArtifacts.detail}
          .artifacts=${withArtifacts.artifacts}
          .learnings=${withArtifacts.learnings}
          .missingData=${withArtifacts.missingData}
          @step-artifact-click=${onClick}
        ></step-artifacts>
      </div>
      <div>
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">Empty (no artifacts)</h3>
        <step-artifacts
          .stepName=${empty.stepName}
          .status=${empty.status}
          .durationMs=${empty.durationMs}
          .artifacts=${empty.artifacts}
          .learnings=${empty.learnings}
          .missingData=${empty.missingData}
        ></step-artifacts>
      </div>
      <div>
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">With learnings + missing</h3>
        <step-artifacts
          .stepName=${withLearningsAndMissing.stepName}
          .status=${withLearningsAndMissing.status}
          .durationMs=${withLearningsAndMissing.durationMs}
          .detail=${withLearningsAndMissing.detail}
          .artifacts=${withLearningsAndMissing.artifacts}
          .learnings=${withLearningsAndMissing.learnings}
          .missingData=${withLearningsAndMissing.missingData}
          @step-artifact-click=${onClick}
        ></step-artifacts>
      </div>
    </div>`;
  }

  private renderDispatchWizard() {
    const slots = [
      mockSlot({
        slot: 'runner-local-mobile-1',
        machine: 'runner-local',
        lifecycle: 'ready',
        branch: 'feature/perps-reuse-worker',
        health: mockHealth(),
        currentTicketOrPr: 'example-org/example-mobile#29373',
      }),
      mockSlot({
        slot: 'runner-local-mobile-2',
        machine: 'runner-local',
        lifecycle: 'ready',
        branch: 'main',
        health: mockHealth(),
      }),
      mockSlot({
        slot: 'runner-local-mobile-3',
        machine: 'runner-local',
        lifecycle: 'ready',
        branch: 'main',
        health: mockHealth({ cdp: 'OFF' }),
      }),
      mockSlot({
        slot: 'runner-a-example-1',
        machine: 'runner-a',
        lifecycle: 'busy',
        phase: 'working',
        agent: 'working',
        branch: 'feature/perps-reuse-worker',
        runner: 'claude',
        currentTicketOrPr: 'example-org/example-mobile#29373',
        taskId: 'PR-29373',
      }),
      mockSlot({
        slot: 'runner-a-example-2',
        machine: 'runner-a',
        lifecycle: 'ready',
        branch: 'fix/old-branch',
        health: mockHealth({ fixtures: '2/3' }),
      }),
      mockSlot({
        slot: 'runner-b-mobile-1',
        machine: 'runner-b',
        lifecycle: 'disabled',
        enabled: false,
        branch: 'main',
        health: mockHealth({ ssh: 'FAIL', device: '-', devserver: '-', cdp: '-', fixtures: '-' }),
      }),
    ];
    const fleet: FleetStatus = {
      checkedAt: new Date().toISOString(),
      slots,
      summary: {
        total: slots.length,
        ready: slots.filter((s) => s.lifecycle === 'ready').length,
        busy: slots.filter((s) => s.lifecycle === 'busy').length,
        held: slots.filter((s) => s.lifecycle === 'held').length,
        manual: slots.filter((s) => s.lifecycle === 'manual').length,
        disabled: slots.filter((s) => s.lifecycle === 'disabled').length,
        blocked: 0,
        warmCount: slots.filter((s) => s.lifecycle === 'ready' && s.warm).length,
      },
    };
    const candidates: DispatchCandidatesResult['candidates'] = [
      {
        slotId: 'runner-a-example-1',
        score: 999,
        cdpLive: true,
        branch: 'feature/perps-reuse-worker',
        lifecycle: 'busy',
        onMain: false,
        free: false,
        nudgeEligible: true,
        nudgeMeta: {
          uncommittedCount: 2,
          uncommittedFiles: ['app/components/Perps/Order.tsx', 'e2e/specs/perps.spec.ts'],
          nudgeCount: 1,
          ctxPct: 62,
          prMatchKind: 'pr-number',
          riskFlags: [],
          canNudge: true,
        },
      },
      {
        slotId: 'runner-local-mobile-1',
        score: -100,
        cdpLive: true,
        branch: 'feature/perps-reuse-worker',
        lifecycle: 'ready',
        onMain: false,
        free: true,
      },
      {
        slotId: 'runner-local-mobile-2',
        score: 0,
        cdpLive: true,
        branch: 'main',
        lifecycle: 'ready',
        onMain: true,
        free: true,
      },
      {
        slotId: 'runner-local-mobile-3',
        score: 5,
        cdpLive: false,
        branch: 'main',
        lifecycle: 'ready',
        onMain: true,
        free: true,
      },
      {
        slotId: 'runner-a-example-2',
        score: 51,
        cdpLive: true,
        branch: 'fix/old-branch',
        lifecycle: 'ready',
        onMain: false,
        free: true,
      },
      {
        slotId: 'runner-b-mobile-1',
        score: 999,
        cdpLive: false,
        branch: 'main',
        lifecycle: 'disabled',
        onMain: true,
        free: false,
      },
    ];
    const projectConfigs: ProjectConfig[] = [
      {
        name: 'example-mobile',
        repoUrl: 'https://github.com/example-org/example-mobile',
        defaultBranch: 'main',
        apps: ['mobile'],
        paths: { runtimeDir: '.farm/runtime', artifactDir: '.farm/artifacts' },
        defaults: {},
        hooks: {},
        health: {},
        ci: {
          repo: 'example-org/example-mobile',
          watchChecks: [],
          checkGroups: [],
          botPatterns: [],
        },
        jira: { project: 'PROJ' },
      },
    ];
    const dispatchPr: PRStatus = {
      pr: 29373,
      title: 'fix: reuse perps worker branch during dispatch',
      summary: 'Dev harness PR used to exercise branch-affinity slot ranking',
      repo: 'example-org/example-mobile',
      headRef: 'feature/perps-reuse-worker',
      project: 'example-mobile',
      slot: 'runner-a-example-1',
      session: 'example-1',
      checks: [],
      checkSummary: { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 },
      allPassed: false,
      anyFailed: false,
      failedNames: [],
      botComments: [],
      actionableBotComments: [],
      prState: 'OPEN',
      merged: false,
      mergeable: 'MERGEABLE',
      mergeConflict: false,
      reviewDecision: '',
      recommendation: 'WORKING',
    };

    // Seed prior runs that share the dispatch ticket so the in-wizard "fork
    // comparison" banner is exercisable from #dev/dispatch-wizard. Two siblings
    // already exist (claude/sonnet + codex/gpt-5.5) so picking same-runner+model
    // also surfaces the variant-input collision flow.
    const dispatchTicket = 'example-org/example-mobile#29373';
    const familyId = 'pr29373-family-1';
    const nowIso = (offsetMin: number) => new Date(Date.now() - offsetMin * 60_000).toISOString();
    const priorRuns: Run[] = [
      {
        id: 'pr29373-root',
        familyId,
        familyRootTicketOrPr: dispatchTicket,
        parentRunId: null,
        lane: 'production',
        variant: null,
        flowType: 'pr-complete',
        mode: 'autonomous',
        status: 'done',
        project: 'example-mobile',
        ticketOrPr: dispatchTicket,
        slotId: 'runner-local-mobile-1',
        branch: 'feature/perps-reuse-worker',
        taskFile: 'tasks/PR-29373.md',
        steps: [],
        decisions: [],
        metrics: {
          nudgeCount: 0,
          model: 'sonnet',
          runner: 'claude',
          runnerSessionId: null,
          runnerSessionPath: null,
          outcome: 'success',
        },
        prNumber: 29373,
        summary: 'Original pr-complete run that landed the perps reuse fix',
        createdAt: nowIso(180),
        updatedAt: nowIso(120),
      },
      {
        id: 'pr29373-comp-claude',
        familyId,
        familyRootTicketOrPr: dispatchTicket,
        parentRunId: 'pr29373-root',
        lane: 'comparison',
        variant: 'claude-sonnet',
        flowType: 'pr-complete',
        mode: 'autonomous',
        status: 'done',
        project: 'example-mobile',
        ticketOrPr: dispatchTicket,
        slotId: 'runner-local-mobile-2',
        branch: 'feature/perps-reuse-worker-cmp-claude',
        taskFile: 'tasks/PR-29373-cmp-claude.md',
        steps: [],
        decisions: [],
        metrics: {
          nudgeCount: 0,
          model: 'sonnet',
          runner: 'claude',
          runnerSessionId: null,
          runnerSessionPath: null,
          outcome: 'success',
        },
        prNumber: 29373,
        summary: 'Same-runner sibling that proved the recipe-edit comparison',
        createdAt: nowIso(90),
        updatedAt: nowIso(60),
      },
      {
        id: 'pr29373-comp-codex',
        familyId,
        familyRootTicketOrPr: dispatchTicket,
        parentRunId: 'pr29373-root',
        lane: 'comparison',
        variant: 'codex-gpt-5-5',
        flowType: 'pr-complete',
        mode: 'autonomous',
        status: 'done',
        project: 'example-mobile',
        ticketOrPr: dispatchTicket,
        slotId: 'runner-a-example-1',
        branch: 'feature/perps-reuse-worker-cmp-codex',
        taskFile: 'tasks/PR-29373-cmp-codex.md',
        steps: [],
        decisions: [],
        metrics: {
          nudgeCount: 0,
          model: 'gpt-5.5',
          runner: 'codex',
          runnerSessionId: null,
          runnerSessionPath: null,
          outcome: 'success',
        },
        prNumber: 29373,
        summary: 'Cross-runner sibling — different model, no variant collision',
        createdAt: nowIso(45),
        updatedAt: nowIso(30),
      },
    ];

    this._updateMockFleet(fleet);
    this._updateMockPRs([...mockPRList(), dispatchPr]);
    this._updateMockQueueItems([]);
    this._updateMockRuns(priorRuns);

    return html`
      <p class="section-label">
        Dispatch wizard — production selector with mocked gateway candidate data
      </p>
      <div
        style="height: calc(100vh - 160px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <dispatch-wizard
          mock-mode
          .mockInitial=${{
            flowType: 'pr-complete',
            ticketId: 'example-org/example-mobile#29373',
            normalizedTicket: 'example-org/example-mobile#29373',
            project: 'example-mobile',
            runner: 'claude',
            model: 'sonnet',
          }}
          .mockCandidates=${candidates}
          .mockProjectConfigs=${projectConfigs}
          .mockPriorRuns=${priorRuns}
        ></dispatch-wizard>
      </div>
    `;
  }

  // Simulates the gateway's domain/run-mode catalog query so the picker's
  // refiltering, empty, and partially-unavailable states are demoable offline.
  private _pickerCatalog(
    domain: string,
    mode: 'autonomous' | 'interactive',
  ): ExecutionTemplateOptions {
    const all: ExecutionTemplateCatalogOption[] = [
      {
        id: 'fix-bug/default',
        sourceId: 'project:example-mobile-farm',
        sourceKind: 'project',
        flow: 'fix-bug',
        runMode: 'autonomous',
        platforms: ['mobile'],
        labels: [],
        relativePath: 'fix-bug.md',
        sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        title: 'Project fix-bug default',
      },
      {
        id: 'fix-bug/settlement-interactive.mobile',
        sourceId: 'team:money-movement',
        sourceKind: 'workspace',
        flow: 'fix-bug',
        runMode: 'interactive',
        platforms: ['mobile'],
        labels: ['domain:money-movement'],
        relativePath: 'fix-bug/settlement-interactive.mobile.md',
        sha256: 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
        title: 'Money-movement settlement walkthrough',
      },
      {
        id: 'fix-bug/autonomous.mobile',
        sourceId: 'package:consensys-recipe-cook',
        sourceKind: 'package',
        flow: 'fix-bug',
        runMode: 'autonomous',
        platforms: ['mobile'],
        labels: [],
        relativePath: 'fix-bug/autonomous.mobile.md',
        sha256: 'c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2',
        title: 'Recipe-cook autonomous mobile',
        description: 'Shared catalog checklist for autonomous mobile bug proofs.',
      },
      {
        id: 'fix-bug/sentry-cuf-autonomous.mobile',
        sourceId: 'team:perps',
        sourceKind: 'workspace',
        flow: 'fix-bug',
        runMode: 'autonomous',
        platforms: ['mobile'],
        labels: ['domain:perps'],
        relativePath: 'fix-bug/sentry-cuf-autonomous.mobile.md',
        sha256: 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3',
        title: 'Perps Sentry CUF proof',
        description: 'Choose for autonomous Perps bug reproduction on Mobile.',
      },
      {
        id: 'fix-bug/settlement-autonomous.mobile',
        sourceId: 'team:money-movement',
        sourceKind: 'workspace',
        flow: 'fix-bug',
        runMode: 'autonomous',
        platforms: ['mobile'],
        labels: ['domain:money-movement'],
        relativePath: 'fix-bug/settlement-autonomous.mobile.md',
        sha256: 'e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
        title: 'Money-movement settlement proof',
      },
    ];
    const domainSources: Record<string, string> = {
      'team:perps': 'perps',
      'team:money-movement': 'money-movement',
    };
    const options = all.filter((option) => {
      if (option.runMode !== mode) return false;
      const optionDomain = option.labels
        .find((label) => label.startsWith('domain:'))
        ?.slice('domain:'.length);
      return optionDomain === undefined || optionDomain === domain;
    });
    const filteredSources = Object.entries(domainSources)
      .filter(([, sourceDomain]) => sourceDomain !== domain)
      .map(([id, sourceDomain]) => ({
        id,
        reason: 'domain-restricted' as const,
        domains: [sourceDomain],
      }));
    return {
      configured: true,
      options,
      availableDomains: ['money-movement', 'perps'],
      ...(options.length > 0
        ? { selectedId: options[0]!.id, selectionReason: 'configured-default' }
        : {}),
      unavailableSources: [{ id: 'team:optional', reason: 'missing-environment' }],
      filteredSources,
    };
  }

  private renderExecutionTemplatePicker() {
    const catalog = this._pickerCatalog(this._pickerDomain, this._pickerMode);
    return html`
      <div class="dev-section">
        <h2>Execution Template Picker — multi-domain, multi-mode catalog</h2>
        <p>
          Domain and Run mode live inside the picker; switching them refilters the table, updates
          the count, and surfaces domain-restricted and unavailable sources. The
          <code>interactive</code> mode with a domain shows the filter-named empty state.
        </p>
        <execution-template-picker
          .catalog=${catalog}
          .selectedId=${this._pickerSelectedId}
          .domain=${this._pickerDomain}
          .mode=${this._pickerMode}
          @template-select=${(event: CustomEvent<{ id: string }>) => {
            // Unlike the dispatch wizard (which resets selection on filter
            // change), the harness keeps the selection so the picker's
            // invalid-selection state stays demoable.
            this._pickerSelectedId = event.detail.id;
          }}
          @domain-change=${(event: CustomEvent<{ domain: string }>) => {
            this._pickerDomain = event.detail.domain;
          }}
          @mode-change=${(event: CustomEvent<{ mode: 'autonomous' | 'interactive' }>) => {
            this._pickerMode = event.detail.mode;
          }}
          @template-preview=${(event: CustomEvent<{ option: ExecutionTemplateCatalogOption }>) => {
            alert(`Preview requested: ${event.detail.option.id}`);
          }}
        ></execution-template-picker>
      </div>
    `;
  }

  private renderBacklog() {
    const now = Date.now();
    const items: BacklogItem[] = [
      {
        id: 'backlog-1',
        project: 'metamask-mobile-farm',
        title: 'Fix flaky perps close confirmation',
        sourceKind: 'jira',
        sourceRef: 'PROJ-3101',
        flowType: 'fix-bug',
        status: 'ready',
        notes: 'Prioritize the simulator reproduction and keep the fix narrow.',
        priority: 5,
        allowedSlots: ['runner-local-mobile-1'],
        autoDispatch: true,
        launchPlan: {
          id: 'lp-dev-compare',
          version: 1,
          candidates: [
            {
              id: 'baseline',
              role: 'baseline',
              runner: 'claude',
              model: 'opus',
              slotPolicy: { kind: 'exact', slotId: 'runner-local-mobile-1' },
            },
            {
              id: 'sonnet',
              role: 'comparison',
              runner: 'claude',
              model: 'sonnet',
              variant: 'claude-sonnet',
              slotPolicy: {
                kind: 'pool',
                allowedSlots: ['runner-local-mobile-2', 'runner-local-mobile-3'],
              },
            },
            {
              id: 'codex',
              role: 'comparison',
              runner: 'codex',
              model: 'gpt-5.5',
              variant: 'codex-gpt-55',
              slotPolicy: {
                kind: 'spread',
                allowedSlots: ['runner-local-mobile-1', 'runner-local-mobile-2'],
              },
            },
          ],
        },
        launchPlanState: {
          launchGroupId: 'lg-dev-compare',
          baselineQueueItemId: 'q-base',
          candidates: [
            {
              candidateId: 'baseline',
              status: 'running',
              runId: 'run-base',
              slotId: 'runner-local-mobile-1',
            },
            { candidateId: 'sonnet', status: 'queued', queueItemId: 'q-sonnet' },
            {
              candidateId: 'codex',
              status: 'blocked',
              waitingReason: 'waiting for spread slot outside active sibling',
            },
          ],
        },
        createdAt: new Date(now - 60 * 60_000).toISOString(),
        updatedAt: new Date(now - 10 * 60_000).toISOString(),
      },
      {
        id: 'backlog-2',
        project: 'metamask-extension-farm',
        title: 'Explore quick dev command for rough intake',
        sourceKind: 'manual',
        sourceRef: 'MANUAL-000002',
        flowType: 'dev',
        status: 'candidate',
        notes: 'Rough roadmap idea; keep as backlog intake, not v1 rough-idea refinement.',
        priority: 20,
        createdAt: new Date(now - 2 * 60 * 60_000).toISOString(),
        updatedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      },
    ];
    const linkedRun: Run = {
      ...mockPipelineRuns()[0],
      id: 'run-backlog-1-current',
      familyId: 'run-backlog-1-current',
      project: items[0].project,
      ticketOrPr: items[0].sourceRef,
      backlogItemId: items[0].id,
      updatedAt: new Date(now - 2 * 60_000).toISOString(),
    };
    const demoRuns = [...mockPipelineRuns(), linkedRun];
    this._captureSharedState();
    updateFleet({
      summary: {
        total: 2,
        ready: 2,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 2,
      },
      machines: [],
      slots: mockFleetSlots(),
      checkedAt: new Date().toISOString(),
    });
    updateBacklogItems(items);
    return html`<backlog-panel
      .items=${items}
      .slots=${mockFleetSlots()}
      .demoRuns=${demoRuns}
    ></backlog-panel>`;
  }

  private renderRoadmap() {
    const now = new Date().toISOString();
    const backlogItems: BacklogItem[] = [
      {
        id: 'roadmap-backlog-extension',
        project: 'metamask-extension-farm',
        title: 'Extension client follow-up',
        sourceKind: 'manual',
        sourceRef: 'ri_dev_refined',
        flowType: 'dev',
        status: 'running',
        notes: 'Promoted from the dev harness roadmap item.',
        priority: 40,
        roadmapItemId: 'ri_dev_refined',
        specPath: '.roadmap/promotion-drafts/ri_dev_refined/01-extension.md',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'roadmap-backlog-mobile',
        project: 'metamask-mobile-farm',
        title: 'Mobile client follow-up',
        sourceKind: 'manual',
        sourceRef: 'ri_dev_refined',
        flowType: 'dev',
        status: 'ready',
        notes: 'Promoted from the dev harness roadmap item.',
        priority: 40,
        roadmapItemId: 'ri_dev_refined',
        specPath: '.roadmap/promotion-drafts/ri_dev_refined/02-mobile.md',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const item: RoadmapItem = {
      id: 'ri_dev_refined',
      kind: 'roadmap-item',
      project: 'farmslot-farm',
      targetProjects: ['metamask-extension-farm', 'metamask-mobile-farm'],
      title: 'Dev harness refined roadmap item',
      stage: 'refined',
      tags: ['roadmap', 'dev-harness'],
      source: { kind: 'manual' },
      promotion: backlogItems.map((backlogItem) => ({
        backlogItemId: backlogItem.id,
        specPath: backlogItem.specPath,
        project: backlogItem.project,
        createdAt: now,
      })),
      body: [
        '## Problem',
        '',
        'A rough idea was refined into separate client backlog drafts.',
        '',
        '## Proposed Solution',
        '',
        'Create one follow-up backlog item per target client.',
        '',
        '## Non-goals',
        '',
        '- Do not dispatch automatically.',
        '',
        '## Risks',
        '',
        '- Client contracts may drift if drafts are unclear.',
        '',
        '## Dispatch Notes',
        '',
        'Review each draft before promotion.',
        '',
        '## Acceptance Criteria',
        '',
        '- Drafts can be reviewed and edited before promotion.',
        '',
        '## Backlog Drafts',
        '',
        '### Backlog Draft: Extension client follow-up',
        '',
        'Project: `metamask-extension-farm`',
        '',
        '#### Implementation Notes',
        '',
        '- Consume the updated controller analytics contract.',
        '',
        '## Acceptance Criteria',
        '',
        '- Extension emits the updated analytics fields.',
        '',
        '### Backlog Draft: Mobile client follow-up',
        '',
        'Project: `metamask-mobile-farm`',
        '',
        '#### Implementation Notes',
        '',
        '- Consume the updated controller analytics contract.',
        '',
        '## Acceptance Criteria',
        '',
        '- Mobile emits the updated analytics fields.',
      ].join('\n'),
      createdAt: now,
      updatedAt: now,
      filePath: '.roadmap/inbox/items/dev-harness-refined-roadmap-item.md',
      fileHash: 'dev-roadmap-hash',
    };
    this._captureSharedState();
    updateFleet({
      summary: {
        total: 2,
        ready: 2,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 2,
      },
      machines: [],
      slots: mockFleetSlots(),
      checkedAt: now,
    });
    // Regression fixture for the reported drift (MANUAL-000072): roadmap item
    // ri_790ea3508ba4 was manually backlinked from MANUAL-000059, run 2e357072
    // completed and deeeed/farmslot#421 merged, yet the item still read as rough
    // with no promotion entry. It must render as delivered with a reconcile
    // finding. `ri_dev_unstarted` is the contrasting no-evidence state.
    const deliveredItem: RoadmapItem = {
      ...item,
      id: 'ri_790ea3508ba4',
      title: 'Roadmap delivery lineage: link backlog, runs, and PRs',
      stage: 'rough',
      targetProjects: [],
      promotion: undefined,
      body: 'Manually backlinked roadmap item that shipped without promotion provenance.',
      filePath: '.roadmap/inbox/items/roadmap-delivery-lineage.md',
      fileHash: 'dev-delivered-hash',
    };
    const unstartedItem: RoadmapItem = {
      ...item,
      id: 'ri_dev_unstarted',
      title: 'Rough idea with no implementation yet',
      stage: 'rough',
      targetProjects: [],
      promotion: undefined,
      body: 'No backlog item, run, or PR is linked to this roadmap item.',
      filePath: '.roadmap/inbox/items/rough-idea.md',
      fileHash: 'dev-unstarted-hash',
    };
    const delivery: RoadmapDeliveryProjection[] = [
      {
        roadmapItemId: 'ri_790ea3508ba4',
        status: 'delivered',
        backlogItems: [
          {
            backlogItemId: 'roadmap-backlog-manual-000059',
            ref: 'MANUAL-000059',
            title: 'Roadmap delivery lineage',
            project: 'farmslot-farm',
            status: 'done',
            specPath: '.backlog/specs/manual-000059.md',
            archived: false,
            delivered: true,
            resolved: true,
            linkSource: 'backlog',
            runFamilies: [
              {
                familyId: '2e357072-36f3-4586-91c4-8e5b6bf362fe',
                runIds: ['2e357072-36f3-4586-91c4-8e5b6bf362fe'],
                latestRunId: '2e357072-36f3-4586-91c4-8e5b6bf362fe',
                latestStatus: 'done',
                latestUpdatedAt: now,
              },
            ],
            prs: [
              {
                ref: 'deeeed/farmslot#421',
                url: 'https://github.com/deeeed/farmslot/pull/421',
                sources: ['run-link', 'run-pr-number'],
              },
            ],
          },
        ],
        runFamilies: [
          {
            familyId: '2e357072-36f3-4586-91c4-8e5b6bf362fe',
            runIds: ['2e357072-36f3-4586-91c4-8e5b6bf362fe'],
            latestRunId: '2e357072-36f3-4586-91c4-8e5b6bf362fe',
            latestStatus: 'done',
            latestUpdatedAt: now,
          },
        ],
        prs: [
          {
            ref: 'deeeed/farmslot#421',
            url: 'https://github.com/deeeed/farmslot/pull/421',
            sources: ['run-link', 'run-pr-number'],
          },
        ],
        findings: [
          {
            code: 'backlog-link-not-in-promotion',
            backlogItemId: 'roadmap-backlog-manual-000059',
            detail:
              'Backlog item roadmap-backlog-manual-000059 links to ri_790ea3508ba4 through roadmapItemId with no matching promotion provenance.',
            remediation:
              'Treat the backlog link as canonical; add a promotion entry only if the provenance record matters.',
          },
          {
            code: 'planning-stage-behind-delivery',
            detail: "Delivery is complete but the authored planning stage is still 'rough'.",
            remediation:
              "Edit ri_790ea3508ba4 to stage 'promoted' or 'archived' once the outcome is reviewed; the gateway does not rewrite roadmap markdown.",
          },
        ],
        generatedAt: now,
      },
      {
        roadmapItemId: 'ri_dev_unstarted',
        status: 'unstarted',
        backlogItems: [],
        runFamilies: [],
        prs: [],
        findings: [],
        generatedAt: now,
      },
      {
        roadmapItemId: 'ri_dev_refined',
        status: 'active',
        backlogItems: backlogItems.map((backlogItem) => ({
          backlogItemId: backlogItem.id,
          ref: backlogItem.sourceRef,
          title: backlogItem.title,
          project: backlogItem.project,
          status: backlogItem.status,
          specPath: backlogItem.specPath,
          archived: false,
          delivered: false,
          resolved: true,
          linkSource: 'both' as const,
          runFamilies: [],
          prs: [],
        })),
        runFamilies: [],
        prs: [],
        findings: [],
        generatedAt: now,
      },
    ];
    updateBacklogItems(backlogItems);
    return html`<roadmap-panel
      .items=${[item, deliveredItem, unstartedItem]}
      .slots=${mockFleetSlots()}
      .delivery=${delivery}
    ></roadmap-panel>`;
  }

  private renderDispatchQueue() {
    const nowIso = (offsetMin: number) => new Date(Date.now() - offsetMin * 60_000).toISOString();
    const items: QueueItem[] = [
      {
        id: 'queue-eval-1',
        queueKind: 'eval-cell',
        label: 'Unlock regression / replay candidate',
        flowType: 'fix-bug',
        project: 'example-mobile',
        ticketOrPr: 'EVAL-UNLOCK001',
        familyId: 'eval-family-1',
        familyRootTicketOrPr: 'EVAL-UNLOCK001',
        lane: 'comparison',
        variant: 'claude-sonnet',
        model: 'sonnet',
        runner: 'claude',
        mode: 'validation',
        slotId: 'runner-local-mobile-1',
        allowedSlots: ['runner-local-mobile-1', 'runner-local-mobile-2'],
        completionPolicy: 'artifact-only',
        priority: 10,
        createdAt: nowIso(14),
        status: 'queued',
        evalCell: {
          capGroupId: 'suite-demo-eval',
          suiteId: 'dataset-demo-eval',
          cellId: 'case-unlock:replay',
          caseSelectionId: 'case-unlock',
          candidateId: 'replay',
          candidateLabel: 'Replay candidate',
          experimentId: 'eval-unlock-case',
          experimentKey: 'unlock-regression',
          experimentManifestPath: '/tmp/farmslot/evals/unlock/artifacts/experiment-manifest.json',
          trialId: 'cell-unlock-replay',
          trialStartParams: {},
        },
      },
      {
        id: 'queue-dispatch-1',
        queueKind: 'dispatch',
        label: 'Perps close position follow-up',
        flowType: 'fix-bug',
        project: 'example-mobile',
        ticketOrPr: 'PROJ-2601',
        model: 'gpt-5.5',
        runner: 'codex',
        mode: 'interactive',
        allowedSlots: null,
        priority: 20,
        createdAt: nowIso(8),
        status: 'queued',
      },
      {
        id: 'queue-eval-2',
        queueKind: 'eval-cell',
        label: 'Unlock regression / template challenger',
        flowType: 'fix-bug',
        project: 'example-mobile',
        ticketOrPr: 'EVAL-UNLOCK002',
        familyId: 'eval-family-1',
        familyRootTicketOrPr: 'EVAL-UNLOCK002',
        lane: 'comparison',
        variant: 'codex-gpt-5-5',
        model: 'gpt-5.5',
        runner: 'codex',
        mode: 'validation',
        allowedSlots: ['runner-a-example-1'],
        completionPolicy: 'artifact-only',
        priority: 30,
        createdAt: nowIso(2),
        status: 'queued',
        evalCell: {
          capGroupId: 'suite-demo-eval',
          suiteId: 'dataset-demo-eval',
          cellId: 'case-unlock:challenger',
          caseSelectionId: 'case-unlock',
          candidateId: 'challenger',
          candidateLabel: 'Template challenger',
          experimentId: 'eval-unlock-case',
          experimentKey: 'unlock-regression',
          experimentManifestPath: '/tmp/farmslot/evals/unlock/artifacts/experiment-manifest.json',
          trialId: 'cell-unlock-challenger',
          trialStartParams: {},
        },
      },
    ];
    this._updateMockFleet(mockFleetStatus());
    this._updateMockQueueItems(items);
    return html`
      <p class="section-label">
        Dispatch queue — shared backlog with normal dispatches and eval cells
      </p>
      <div style="max-width: 960px">
        <dispatch-queue-panel .items=${items} .panelTitle=${'Shared Queue'}></dispatch-queue-panel>
      </div>
    `;
  }

  private renderResourcePanel() {
    const mockResources = [
      {
        id: 'ios-sim',
        definition: {
          type: 'device' as const,
          platform: 'ios',
          label: 'iOS Simulator',
          streamable: true,
          controllable: true,
          hooks: { boot: 'echo boot', shutdown: 'echo shutdown', relaunch: 'echo relaunch' },
        },
        status: 'running' as const,
      },
      {
        id: 'android-emu',
        definition: {
          type: 'device' as const,
          platform: 'android',
          label: 'Android Emulator',
          streamable: true,
          controllable: true,
          hooks: { boot: 'echo boot', shutdown: 'echo shutdown', relaunch: 'echo relaunch' },
        },
        status: 'stopped' as const,
      },
      {
        id: 'browser',
        definition: {
          type: 'browser' as const,
          platform: 'chrome-extension',
          label: 'Extension Browser',
          streamable: true,
          controllable: true,
          hooks: { boot: 'echo boot', shutdown: 'echo shutdown' },
        },
        status: 'unknown' as const,
      },
      {
        id: 'dev-server',
        definition: {
          type: 'dev-server' as const,
          label: 'Metro',
          streamable: false,
          controllable: true,
          hooks: { shutdown: 'echo shutdown' },
        },
        status: 'running' as const,
      },
    ];
    const mockActions = [
      {
        id: 'resource:browser:copy-fullscreen',
        label: 'Copy Full',
        mode: 'copy' as const,
        style: 'secondary' as const,
        placement: ['resource-panel' as const],
        refresh: ['none' as const],
        resourceId: 'browser',
      },
      {
        id: 'resource:browser:fullscreen',
        label: 'Full',
        mode: 'run' as const,
        style: 'primary' as const,
        placement: ['resource-panel' as const],
        refresh: ['resources' as const],
        resourceId: 'browser',
      },
    ];

    return html`
      <p class="section-label">
        Resource Panel (mock resources — 2 devices + 1 browser + 1 dev-server)
      </p>
      <p style="color: ${colors.textMuted}; font-size: 11px; margin-bottom: 8px">
        Click resource chips to activate streams. Click active chip to deactivate. Control buttons
        (RL/On/Off) appear for active controllable resources.
      </p>
      <div style="display: flex; gap: ${spacing.lg}; height: calc(100vh - 240px)">
        <div
          style="flex: 1; background: ${colors.bgCard}; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: ${colors.textMuted}; font-size: 12px"
        >
          Editor placeholder (code area)
        </div>
        <div style="width: 320px; flex-shrink: 0">
          <resource-panel
            slotId="mock-slot-1"
            .resources=${mockResources}
            .actions=${mockActions}
            @resource-control=${(e: CustomEvent) => console.log('[dev] resource-control', e.detail)}
            @slot-action-run=${(e: CustomEvent) => console.log('[dev] slot-action-run', e.detail)}
            @panel-close=${() => console.log('[dev] panel-close')}
          ></resource-panel>
        </div>
      </div>
    `;
  }

  private renderDeviceGrid() {
    return html`
      <p class="section-label">
        Device Grid (requires live gateway for real resources, or shows empty state)
      </p>
      <div
        style="height: calc(100vh - 160px); border: 1px solid ${colors.bgCard}; border-radius: 8px; overflow: hidden"
      >
        <device-grid></device-grid>
      </div>
    `;
  }

  private renderGlobalFilter() {
    return html`
      <div style="padding: 20px; background: ${colors.bgBase}">
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">Global Filter Bar</h3>
        <global-filter-bar .slots=${mockFleetSlots()}></global-filter-bar>
        <p style="color: ${colors.textMuted}; margin-top: 16px; font-size: 12px">
          Select projects/machines above. Selections cascade.
        </p>
      </div>
    `;
  }

  private renderRunnerModelEffortPicker() {
    const onChange = (event: CustomEvent<RunnerModelEffortChangeDetail>) => {
      this._pickerRunner = event.detail.runner;
      this._pickerModel = event.detail.model;
      this._pickerEffort = event.detail.effort;
    };
    return html`
      <div style="padding: 20px; background: ${colors.bgBase}; min-height: 70vh;">
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">
          Runner / Model / Effort Picker
        </h3>
        <div style="display: grid; gap: 20px; max-width: 920px; color: ${colors.textPrimary};">
          <section
            style="border: 1px solid ${colors.bgCard}; border-radius: 8px; padding: 16px; background: ${colors.bgSurface};"
          >
            <div style="color:${colors.textMuted}; font-size: 12px; margin-bottom: 12px;">
              Dispatch mode
            </div>
            <runner-model-effort-picker
              .runner=${this._pickerRunner}
              .model=${this._pickerModel}
              .effort=${this._pickerEffort}
              @runner-model-effort-change=${onChange}
            ></runner-model-effort-picker>
          </section>
          <section
            style="border: 1px solid ${colors.bgCard}; border-radius: 8px; padding: 16px; background: ${colors.bgSurface};"
          >
            <div style="color:${colors.textMuted}; font-size: 12px; margin-bottom: 12px;">
              Backlog/WorkGraph mode with default option
            </div>
            <runner-model-effort-picker
              .runner=${this._pickerRunner}
              .model=${this._pickerModel}
              .effort=${this._pickerEffort}
              .allowDefault=${true}
              @runner-model-effort-change=${onChange}
            ></runner-model-effort-picker>
          </section>
          <pre
            style="margin: 0; color: ${colors.textSecondary}; background: ${colors.bgCard}; padding: 12px; border-radius: 8px;"
          >
${JSON.stringify(
              {
                runner: this._pickerRunner,
                model: this._pickerModel,
                effort: this._pickerEffort,
              },
              null,
              2,
            )}</pre
          >
        </div>
      </div>
    `;
  }

  private renderSlotSelector() {
    const slots = mockFleetSlots();
    return html`
      <div style="padding: 20px; background: ${colors.bgBase}; min-height: 70vh;">
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">Slot Selector Modal</h3>
        <p style="color: ${colors.textMuted}; max-width: 720px;">
          Reusable visual slot picker. This mock constrains to the Example App mobile project and a
          runner-local global node filter so the modal demonstrates the same filter matching used by
          backlog dispatch.
        </p>
        <div style="margin-top: 16px; color: ${colors.textPrimary};">
          Selected: ${this._slotSelectorSelection.join(', ') || 'none'}
        </div>
        <slot-selector-modal
          .open=${true}
          .slots=${slots}
          .selected=${this._slotSelectorSelection}
          .filters=${{ projects: [], machines: ['runner-local'] }}
          project="example-mobile"
          heading="Dev harness slot selector"
          @slot-selector-change=${(event: CustomEvent<{ selected: string[] }>) => {
            this._slotSelectorSelection = event.detail.selected;
          }}
        ></slot-selector-modal>
      </div>
    `;
  }

  private renderSlotChoiceList() {
    const slots = mockFleetSlots().filter((slot) => slot.project === 'example-mobile');
    return html`
      <div style="padding: 20px; background: ${colors.bgBase}; min-height: 70vh;">
        <h3 style="color: ${colors.textPrimary}; margin-bottom: 16px">Slot Choice List</h3>
        <p style="color: ${colors.textMuted}; max-width: 720px;">
          Compact dispatch-style slot rows for backlog and WorkGraph allowed-slot selection.
        </p>
        <div style="margin: 16px 0; color: ${colors.textPrimary};">
          Allowed slots: ${this._slotChoiceSelection.join(', ') || 'any eligible'}
        </div>
        <div
          style="max-width: 920px; border: 1px solid ${colors.bgCard}; border-radius: 8px; padding: 16px; background: ${colors.bgSurface};"
        >
          <slot-choice-list
            project="example-mobile"
            .slots=${slots}
            .selectedSlots=${this._slotChoiceSelection}
            @slot-choice-change=${(event: CustomEvent<SlotChoiceChangeDetail>) => {
              this._slotChoiceSelection = event.detail.allowedSlots ?? [];
            }}
          ></slot-choice-list>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <style>
        dev-harness {
          display: block;
          height: 100%;
          overflow: auto;
          background: ${colors.bgBase};
          color: ${colors.textPrimary};
          font-family: ${fonts.mono};
          padding: ${spacing.lg};
        }
        dev-harness .dh-header {
          margin-bottom: ${spacing.lg};
          padding-bottom: ${spacing.md};
          border-bottom: 1px solid ${colors.bgCard};
        }
        dev-harness .dh-header h1 {
          font-size: ${fonts.sizeLg};
          margin: 0 0 ${spacing.sm} 0;
          color: ${colors.accent};
        }
        dev-harness.capture-mode {
          padding: 0;
        }
        dev-harness .dh-nav {
          display: flex;
          flex-direction: column;
          gap: ${spacing.md};
        }
        dev-harness .dh-nav-group-label {
          margin-bottom: ${spacing.xs};
          color: ${colors.textMuted};
          font-size: ${fonts.sizeXs};
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        dev-harness .dh-nav-links {
          display: flex;
          gap: ${spacing.sm};
          flex-wrap: wrap;
        }
        dev-harness .dh-nav a {
          padding: 6px 12px;
          border-radius: 4px;
          background: ${colors.bgCard};
          color: ${colors.textSecondary};
          text-decoration: none;
          font-size: ${fonts.sizeSm};
          cursor: pointer;
          transition: background 0.15s;
        }
        dev-harness .dh-nav a:hover {
          background: ${colors.bgSidebar};
        }
        dev-harness .dh-nav a.active {
          background: ${colors.accent}33;
          color: ${colors.accent};
        }
        dev-harness .section-label {
          font-size: ${fonts.sizeSm};
          color: ${colors.textMuted};
          margin: ${spacing.md} 0 ${spacing.sm} 0;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        dev-harness .card-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: ${spacing.md};
        }
        dev-harness .fleet-container {
          height: calc(100vh - 200px);
          border: 1px solid ${colors.bgCard};
          border-radius: 8px;
          overflow: hidden;
        }
        dev-harness .terminal-placeholder {
          height: 400px;
          background: ${colors.bgSidebar};
          border-radius: 8px;
          padding: ${spacing.md};
          font-size: ${fonts.sizeSm};
          color: ${colors.textMuted};
          overflow: auto;
          white-space: pre-wrap;
          font-family: ${fonts.mono};
        }
        dev-harness .index-section {
          margin-bottom: ${spacing.xl};
        }
        dev-harness .index-section h2 {
          margin: 0 0 ${spacing.md} 0;
          color: ${colors.textPrimary};
          font-size: ${fonts.sizeMd};
        }
        dev-harness .index-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: ${spacing.md};
          margin-top: ${spacing.md};
        }
        dev-harness .index-card {
          background: ${colors.bgCard};
          border-radius: 8px;
          padding: ${spacing.lg};
          cursor: pointer;
          transition: background 0.15s;
        }
        dev-harness .index-card:hover {
          background: ${colors.bgSidebar};
        }
        dev-harness .index-card h3 {
          margin: 0 0 ${spacing.xs} 0;
          color: ${colors.accent};
          font-size: ${fonts.sizeMd};
        }
        dev-harness .index-card p {
          margin: 0;
          color: ${colors.textMuted};
          font-size: ${fonts.sizeSm};
        }
      </style>
      ${this._captureMode
        ? ''
        : html`
            <div class="dh-header">
              <h1>Dev Harness</h1>
              <div class="dh-nav">
                <div>
                  <a
                    class="${this.route === 'index' ? 'active' : ''}"
                    @click=${() => {
                      location.hash = 'dev';
                    }}
                    >Index</a
                  >
                </div>
                ${DEV_ROUTE_GROUPS.map(
                  (group) => html`
                    <div class="dh-nav-group">
                      <div class="dh-nav-group-label">${DEV_ROUTE_GROUP_LABELS[group]}</div>
                      <div class="dh-nav-links">
                        ${DEV_ROUTES.filter((r) => r.group === group).map(
                          (r) => html`
                            <a
                              class="${this.route === r.route ? 'active' : ''}"
                              @click=${() => {
                                location.hash = `dev/${r.route}`;
                              }}
                              >${r.label}</a
                            >
                          `,
                        )}
                      </div>
                    </div>
                  `,
                )}
              </div>
            </div>
          `}
      ${this.renderContent()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dev-harness': DevHarness;
  }
}
