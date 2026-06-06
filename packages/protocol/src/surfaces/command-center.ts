import type { ChatClientContext } from '../contracts/index.js';

export interface CommandCenterSurfaceDefinition {
  surfaceId: string;
  routePattern: string;
  routeRegex: string;
  routeParamNames: string[];
  queryParams: string[];
  componentPath: string;
  componentSymbol: string;
  primaryEntities: string[];
  affordances: string[];
  preferredTools: string[];
  sourceAnchors: string[];
  sampleHash: string;
}

export interface CommandCenterSurfaceMatch {
  surface: CommandCenterSurfaceDefinition;
  route: string;
  hash: string;
  query: Record<string, string>;
  routeParams: Record<string, string>;
  context: Partial<ChatClientContext>;
}

export const COMMAND_CENTER_SURFACES: CommandCenterSurfaceDefinition[] = [
  {
    surfaceId: 'fleet',
    routePattern: '#fleet',
    routeRegex: '^fleet$',
    routeParamNames: [],
    queryParams: [],
    componentPath: 'apps/command-center/ui/src/components/fleet-map/fleet-canvas.ts',
    componentSymbol: 'FleetCanvas',
    primaryEntities: ['fleet', 'slots', 'active runs', 'resources'],
    affordances: ['inspect-fleet'],
    preferredTools: [
      'operator_snapshot',
      'list_active_runs',
      'get_slot',
      'get_machine_health',
      'resource_list',
      'resource_pressure_snapshot',
    ],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:renderContent fleet route',
      'apps/command-center/ui/src/components/fleet-map/fleet-canvas.ts',
    ],
    sampleHash: '#fleet',
  },
  {
    surfaceId: 'pr-dashboard',
    routePattern: '#prs?pr=:pr&repo=:repo',
    routeRegex: '^prs$',
    routeParamNames: [],
    queryParams: ['pr', 'repo', 'view', 'projects', 'machines'],
    componentPath: 'apps/command-center/ui/src/components/pr-dashboard/pr-board.ts',
    componentSymbol: 'PRBoard',
    primaryEntities: [
      'pull requests',
      'CI checks',
      'review state',
      'merge readiness',
      'linked runs',
    ],
    affordances: ['inspect-pr-dashboard', 'inspect-pr-readiness', 'inspect-ci-failures'],
    preferredTools: ['list_pull_requests', 'check_pr', 'operator_snapshot', 'run_context_bundle'],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:renderContent prs route',
      'apps/command-center/ui/src/components/pr-dashboard/pr-board.ts:PRBoard',
    ],
    sampleHash:
      '#prs?pr=123&repo=example-org/example-browser&view=detail&projects=example-browser&machines=runner-local',
  },
  {
    surfaceId: 'dispatch',
    routePattern: '#dispatch?flow=:flow&ticket=:ticket',
    routeRegex: '^dispatch$',
    routeParamNames: [],
    queryParams: ['flow', 'ticket', 'project', 'slot', 'projects', 'machines'],
    componentPath: 'apps/command-center/ui/src/components/dispatch/dispatch-wizard.ts',
    componentSymbol: 'DispatchWizard',
    primaryEntities: ['dispatch form', 'flow type', 'target ticket or PR', 'slot candidates'],
    affordances: ['inspect-dispatch', 'inspect-queue', 'inspect-slot-candidates'],
    preferredTools: ['operator_snapshot', 'queue_list', 'list_active_runs', 'get_slot'],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:renderContent dispatch route',
      'apps/command-center/ui/src/components/dispatch/dispatch-wizard.ts:DispatchWizard',
    ],
    sampleHash:
      '#dispatch?flow=pr-complete&ticket=example-org/example-browser%23123&project=example-browser&slot=runner-browser-1&projects=example-browser&machines=runner-local',
  },
  {
    surfaceId: 'devices',
    routePattern: '#devices',
    routeRegex: '^devices$',
    routeParamNames: [],
    queryParams: [],
    componentPath: 'apps/command-center/ui/src/components/device-grid/device-grid.ts',
    componentSymbol: 'DeviceGrid',
    primaryEntities: ['devices', 'resources', 'streams', 'slot resources'],
    affordances: ['inspect-devices', 'inspect-resources'],
    preferredTools: [
      'operator_snapshot',
      'resource_list',
      'resource_pressure_snapshot',
      'get_slot',
    ],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:renderContent devices route',
      'apps/command-center/ui/src/components/device-grid/device-grid.ts:DeviceGrid',
    ],
    sampleHash: '#devices',
  },
  {
    surfaceId: 'gateway-intelligence',
    routePattern: '#intelligence',
    routeRegex: '^(intelligence|violations)$',
    routeParamNames: [],
    queryParams: [],
    componentPath:
      'apps/command-center/ui/src/components/intelligence-audit/intelligence-incidents-panel.ts',
    componentSymbol: 'IntelligenceIncidentsPanel',
    primaryEntities: [
      'gateway intelligence',
      'monitor signals',
      'auto-recovery audit',
      'operator attention',
    ],
    affordances: [
      'inspect-gateway-intelligence',
      'inspect-monitor-signals',
      'inspect-auto-recovery-audit',
    ],
    preferredTools: [
      'operator_snapshot',
      'get_slot',
      'terminal_snapshot',
      'task_progress',
      'run_context_bundle',
    ],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:renderContent intelligence route',
      'apps/command-center/ui/src/components/intelligence-audit/intelligence-incidents-panel.ts:IntelligenceIncidentsPanel',
    ],
    sampleHash: '#intelligence',
  },
  {
    surfaceId: 'finetune',
    routePattern: '#finetune',
    routeRegex: '^finetune$',
    routeParamNames: [],
    queryParams: [],
    componentPath: 'apps/command-center/ui/src/components/finetune/finetune-page.ts',
    componentSymbol: 'FinetunePage',
    primaryEntities: ['fine-tuning', 'training data', 'model feedback'],
    affordances: ['inspect-finetune'],
    preferredTools: ['operator_snapshot', 'read_farmslot_file', 'search_farmslot_files'],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:renderContent finetune route',
      'apps/command-center/ui/src/components/finetune/finetune-page.ts:FinetunePage',
    ],
    sampleHash: '#finetune',
  },
  {
    surfaceId: 'run-detail',
    routePattern: '#run/:runId',
    routeRegex: '^run/([^/?#]+)$',
    routeParamNames: ['runId'],
    queryParams: ['step'],
    componentPath: 'apps/command-center/ui/src/components/runs/run-detail.ts',
    componentSymbol: 'RunDetail',
    primaryEntities: ['run', 'steps', 'decisions', 'slot', 'task progress'],
    affordances: ['inspect-run', 'inspect-steps'],
    preferredTools: [
      'propose_run_recovery',
      'run_context_bundle',
      'get_run',
      'task_progress',
      'terminal_snapshot',
      'read_task_file',
    ],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:parseHash run/:id',
      'apps/command-center/ui/src/components/runs/run-detail.ts:RunDetail',
    ],
    sampleHash: '#run/run-1?step=prepare',
  },
  {
    surfaceId: 'family-observability',
    routePattern: '#family/:familyId?run=:runId',
    routeRegex: '^family/([^/?#]+)$',
    routeParamNames: ['familyId'],
    queryParams: ['run'],
    componentPath: 'apps/command-center/ui/src/components/runs/family-observability.ts',
    componentSymbol: 'FamilyObservability',
    primaryEntities: [
      'run family',
      'selected run',
      'retrospective',
      'artifacts',
      'learning entries',
    ],
    affordances: ['inspect-retrospective', 'inspect-family-run'],
    preferredTools: [
      'propose_run_recovery',
      'run_context_bundle',
      'get_run',
      'search_runs',
      'operator_snapshot',
    ],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:parseHash family/:id query run',
      'apps/command-center/ui/src/components/runs/family-observability.ts:FamilyObservability.initialRunId',
    ],
    sampleHash: '#family/family-1?run=run-1',
  },
  {
    surfaceId: 'decisions',
    routePattern: '#decisions/:decisionId?',
    routeRegex: '^decisions(?:/([^/?#]+))?$',
    routeParamNames: ['decisionId'],
    queryParams: [],
    componentPath: 'apps/command-center/ui/src/components/decisions/decision-inbox.ts',
    componentSymbol: 'DecisionInbox',
    primaryEntities: ['pending decisions', 'retrospective decisions', 'run gates'],
    affordances: ['inspect-decisions'],
    preferredTools: [
      'operator_snapshot',
      'list_pending_decisions',
      'get_run',
      'propose_run_recovery',
      'run_context_bundle',
    ],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:parseHash decisions route',
      'apps/command-center/ui/src/components/decisions/decision-inbox.ts:DecisionInbox',
    ],
    sampleHash: '#decisions/decision-1',
  },
  {
    surfaceId: 'runs-list',
    routePattern: '#runs?family=:familyId',
    routeRegex: '^runs$',
    routeParamNames: [],
    queryParams: ['family'],
    componentPath: 'apps/command-center/ui/src/components/runs/run-list.ts',
    componentSymbol: 'RunList',
    primaryEntities: ['runs', 'families', 'statuses', 'filters'],
    affordances: ['inspect-runs'],
    preferredTools: ['search_runs', 'list_active_runs', 'operator_snapshot', 'run_context_bundle'],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:renderContent runs route',
      'apps/command-center/ui/src/components/runs/run-list.ts:RunList',
    ],
    sampleHash: '#runs?family=family-1',
  },
  {
    surfaceId: 'runs-compare',
    routePattern: '#runs/compare?a=:runId&b=:runId',
    routeRegex: '^runs/compare$',
    routeParamNames: [],
    queryParams: ['a', 'b'],
    componentPath: 'apps/command-center/ui/src/components/runs/run-compare.ts',
    componentSymbol: 'RunCompare',
    primaryEntities: ['run A', 'run B', 'comparison evidence'],
    affordances: ['compare-runs'],
    preferredTools: ['run_context_bundle', 'get_run', 'search_runs'],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:parseHash runs/compare query a,b',
      'apps/command-center/ui/src/components/runs/run-compare.ts:RunCompare',
    ],
    sampleHash: '#runs/compare?a=run-a&b=run-b',
  },
  {
    surfaceId: 'slot-workspace',
    routePattern: '#slot/:slotId',
    routeRegex: '^slot/([^/?#]+)(?:/workspace)?$',
    routeParamNames: ['slotId'],
    queryParams: ['runId'],
    componentPath: 'apps/command-center/ui/src/components/slot-view/slot-view.ts',
    componentSymbol: 'SlotView',
    primaryEntities: ['slot', 'workspace', 'files', 'terminal', 'linked run'],
    affordances: ['inspect-slot', 'inspect-workspace'],
    preferredTools: [
      'get_slot',
      'git_status',
      'git_diff',
      'task_progress',
      'terminal_snapshot',
      'read_file',
      'list_files',
    ],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:parseHash slot/:id',
      'apps/command-center/ui/src/components/slot-view/slot-view.ts:SlotView',
    ],
    sampleHash: '#slot/slot-1?runId=run-1',
  },
  {
    surfaceId: 'terminal',
    routePattern: '#terminal/:slotId?',
    routeRegex: '^terminal(?:/([^/?#]+))?$',
    routeParamNames: ['slotId'],
    queryParams: [],
    componentPath: 'apps/command-center/ui/src/components/terminal/split-view.ts',
    componentSymbol: 'TerminalSplitView',
    primaryEntities: ['slot terminals', 'tmux panes', 'worker output'],
    affordances: ['inspect-terminal'],
    preferredTools: ['terminal_snapshot', 'task_progress', 'tmux_list', 'get_slot'],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:parseHash terminal/:slotId',
      'apps/command-center/ui/src/components/terminal/split-view.ts:TerminalSplitView',
    ],
    sampleHash: '#terminal/slot-1',
  },
  {
    surfaceId: 'config',
    routePattern: '#config/:name?',
    routeRegex: '^config(?:/([^/?#]+))?$',
    routeParamNames: ['configName'],
    queryParams: [],
    componentPath: 'apps/command-center/ui/src/components/config/config-panel.ts',
    componentSymbol: 'ConfigPanel',
    primaryEntities: ['configuration', 'LLM settings', 'project settings'],
    affordances: ['inspect-config'],
    preferredTools: ['read_farmslot_file', 'search_farmslot_files', 'chat_session_context'],
    sourceAnchors: [
      'apps/command-center/ui/src/components/app-shell.ts:parseHash config/:name',
      'apps/command-center/ui/src/components/config/config-panel.ts:ConfigPanel',
    ],
    sampleHash: '#config/project-a',
  },
];

export function parseCommandCenterHash(hashValue: string): {
  hash: string;
  route: string;
  query: Record<string, string>;
} {
  const hash = hashValue || '#fleet';
  const raw = hash.replace(/^#/, '') || 'fleet';
  const queryStart = raw.indexOf('?');
  const route = queryStart < 0 ? raw : raw.slice(0, queryStart);
  const query = new URLSearchParams(queryStart < 0 ? '' : raw.slice(queryStart + 1));
  const out: Record<string, string> = {};
  for (const [key, value] of query.entries()) out[key] = value;
  return { hash, route: route || 'fleet', query: out };
}

function decodePart(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch (err) {
    // URL hash state is client-controlled. Malformed percent-encoding should
    // make the route uncertain, not fail chat context collection.
    if (err instanceof URIError) return undefined;
    throw err;
  }
}

function routeParamContext(params: Record<string, string>): Partial<ChatClientContext> {
  return {
    ...(params.runId ? { selectedRunId: params.runId } : {}),
    ...(params.familyId ? { selectedFamilyId: params.familyId } : {}),
    ...(params.slotId ? { selectedSlotId: params.slotId } : {}),
    ...(params.decisionId ? { selectedDecisionId: params.decisionId } : {}),
    ...(params.configName ? { selectedConfigName: params.configName } : {}),
  };
}

function queryContext(query: Record<string, string>): Partial<ChatClientContext> {
  return {
    ...(query.step ? { selectedStepName: query.step } : {}),
    ...(query.run ? { selectedRunId: query.run } : {}),
    ...(query.runId ? { selectedRunId: query.runId } : {}),
    ...(query.family ? { selectedFamilyId: query.family } : {}),
    ...(query.pr ? { selectedPullRequestNumber: query.pr } : {}),
    ...(query.repo ? { selectedPullRequestRepo: query.repo } : {}),
    ...(query.pr && query.repo ? { selectedPullRequestRef: `${query.repo}#${query.pr}` } : {}),
    ...(query.a || query.b ? { compareRunIds: [query.a, query.b].filter(Boolean) } : {}),
  };
}

export function matchCommandCenterSurface(hashValue: string): CommandCenterSurfaceMatch | null {
  const { hash, route, query } = parseCommandCenterHash(hashValue);
  for (const surface of COMMAND_CENTER_SURFACES) {
    const match = route.match(new RegExp(surface.routeRegex));
    if (!match) continue;
    const routeParams: Record<string, string> = {};
    for (let i = 0; i < surface.routeParamNames.length; i++) {
      const value = decodePart(match[i + 1]);
      if (value) routeParams[surface.routeParamNames[i]] = value;
    }
    const context = {
      surfaceId: surface.surfaceId,
      routePattern: surface.routePattern,
      affordances: surface.affordances,
      ...routeParamContext(routeParams),
      ...queryContext(query),
    };
    return { surface, route, hash, query, routeParams, context };
  }
  return null;
}

export function buildCommandCenterContext(hashValue: string): ChatClientContext {
  const { hash, route, query } = parseCommandCenterHash(hashValue);
  const matched = matchCommandCenterSurface(hash);
  return {
    route,
    hash,
    query,
    ...(matched
      ? matched.context
      : {
          surfaceId: 'unknown',
          routePattern: route,
          affordances: ['inspect-current-screen'],
        }),
  };
}

/** Co-Pilot's single shared session id. One chat per browser; screen context
 *  rides every message via clientContext so route changes never fork it. */
export const GLOBAL_CHAT_SESSION_ID = 'global';

export function deriveChatSessionId(_context: ChatClientContext): string {
  return GLOBAL_CHAT_SESSION_ID;
}
