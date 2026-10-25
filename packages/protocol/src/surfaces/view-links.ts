import { BACKLOG_STATUSES } from '../contracts/backlog.js';
import type { TmuxWorkerRef } from '../rpc/tmux.js';

// Full-view links preserve navigation state without exposing the app's private
// loopback origin or accepting connection credentials from an external link.
const routes = new Set([
  'fleet',
  'native',
  'terminal',
  'devices',
  'dispatch',
  'roadmap',
  'backlog',
  'work-graphs',
  'prs',
  'decisions',
  'runs',
  'runs/compare',
  'evals',
  'finetune',
  'intelligence',
  'analytics',
  'config',
  'doctor',
  'violations',
]);
const entity =
  /^(run|family|slot|terminal|config)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?:\/workspace)?$/;
// Config uses nested paths such as config/pool/macwork and
// config/flows/fix-bug/interactive/phase/metamask-farm. Keep every segment
// constrained to the same identifier grammar used by entity routes.
const config =
  /^config\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}){0,4}$/;
// These parameters select views or prefill forms. No link submits a form.
export const VIEW_QUERY_PARAMETERS: ReadonlySet<string> = new Set(
  (
    'a b activity artifact artifactAc artifactRun artifactTrace artifactPhase artifactView assessment backlogProject backlogStatus capture create demo dispatchConfig draft draftMode file item resource runId contextId history historyRun host recipeRun recipeDependency ' +
    'recipeNode recipeArtifact recipeEvidenceMode recipeViewer recipeViewerMode recipeViewerPair review reviewAt reviewCheck reviewDrawer reviewFile comment commentFile commentLine commentHead ' +
    'cmpSort cmpTab diffArtifact diffRun direction evidence evidencePreview family familyId flow flowType focus gate graph intent lane ' +
    'layout lightboxIndex lightboxRecipeRunId machines modal mode model node panel parentRunId pr prDraft prEditor prHistory prHost project projects ' +
    'prPane prScope prSection prSort prTab prTarget publicationReviews q refresh qaInputs qaProfileId repo reviewMachine ' +
    'reviewValidationDepth run runner runsTab slot sort start_ref startRef state status step suggestion tab tag ticket tokens trajectory transport ' +
    'validationDepth variant view window worker group promote runnerPicker slotSelector spec workGraphProject wgSort wgDirection sharedView sessionId executionNodeId'
  ).split(' '),
);

export function validViewRoute(route: unknown): route is string {
  if (
    typeof route !== 'string' ||
    route.length > 4096 ||
    !route.startsWith('#') ||
    /[\s\\\u0000-\u001f]/.test(route)
  )
    return false;
  const [path, ...queryParts] = route.slice(1).split('?');
  if (
    (!routes.has(path) && !entity.test(path) && !config.test(path)) ||
    queryParts.length > 1 ||
    route.slice(1).includes('#')
  )
    return false;
  try {
    decodeURIComponent(route); // Reject malformed escapes before URLSearchParams normalizes them.
  } catch {
    return false;
  } // An invalid route cannot be shared or opened.
  const params = new URLSearchParams(queryParts[0] ?? '');
  for (const [key, value] of params) {
    if (!VIEW_QUERY_PARAMETERS.has(key) || /[\u0000-\u001f]/.test(value)) return false;
  }
  return true;
}

export function viewLinkFromRoute(route: unknown): string | null {
  return validViewRoute(route) ? `farmslot://view/${withoutSharedViewMarker(route)}` : null;
}

export function viewRouteFromLink(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('farmslot://view/')) return null;
  const route = value.slice('farmslot://view/'.length);
  return validViewRoute(route) ? route : null;
}

export interface CompanionViewLocation {
  pathname: string;
  params: Readonly<Record<string, string | readonly string[] | undefined>>;
  projects?: readonly string[];
  machines?: readonly string[];
  runFilters?: SharedRunViewSelection;
  runsTab?: 'active' | 'all';
  artifactSelection?: SharedRunArtifactSelection;
  unavailableMessage?: string;
  workerSelection?: TmuxWorkerRef;
}

export interface SharedRunArtifactOwner {
  runId: string;
  slotId?: string;
  recipeRunId?: string;
}

export interface SharedRunArtifactSelection extends SharedRunArtifactOwner {
  path: string;
  criterionId?: string;
  traceIndex?: number;
}

export interface SharedRunViewSelection {
  flow: string;
  lane: string;
  sort: string;
  search: string;
  tag: string;
}

export type SharedViewLocation =
  | { companion: CompanionViewLocation }
  | { route: string }
  | { url: string };

export type SharedViewLink =
  | { status: 'available'; url: string; route: string }
  | {
      status: 'unavailable';
      reason: 'web-url-unset' | 'invalid-web-url' | 'unsupported-view' | 'invalid-view';
      message: string;
    };

const noWebUrl = 'Web link unavailable: set the Command Center URL';
const privateSelectors = new Set(['draft', 'draftMode', 'connect', 'token', 'password', 'code']);
const viewId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function commandCenterUrlError(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '0.0.0.0' ||
      host.startsWith('127.') ||
      host === '::' ||
      host === '::1' ||
      /^::ffff:7f[0-9a-f]{2}:/.test(host)
    )
      return 'Use a reachable HTTPS Command Center URL without credentials, query or fragment.';
    return null;
  } catch {
    return 'Enter an absolute HTTPS Command Center URL.';
  }
}

function unavailable(
  message: string,
  reason: Extract<SharedViewLink, { status: 'unavailable' }>['reason'] = 'unsupported-view',
): SharedViewLink {
  return { status: 'unavailable', reason, message };
}

function withoutSharedViewMarker(route: string): string {
  const [path, query = ''] = route.split('?');
  const params = new URLSearchParams(query);
  if (!params.has('sharedView')) return route;
  params.delete('sharedView');
  return `${path}${params.toString() ? `?${params}` : ''}`;
}

function companionViewRoute(location: CompanionViewLocation): string | null {
  const path = location.pathname.replace(/^\/\(tabs\)/, '') || '/';
  const one = (key: string): string => {
    const value = location.params[key];
    return typeof value === 'string' ? value : value?.length === 1 ? (value[0] ?? '') : '';
  };
  const route = (name: string, values: Readonly<Record<string, string>> = {}): string => {
    const params = new URLSearchParams();
    if (name !== 'native') {
      if (location.projects !== undefined) params.set('projects', location.projects.join(','));
      if (location.machines !== undefined) params.set('machines', location.machines.join(','));
    }
    for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
    return `#${name}${params.toString() ? `?${params}` : ''}`;
  };
  const entity = (expression: RegExp, name: string, param: string): string | null => {
    const match = expression.exec(path);
    const id = match?.[1]?.startsWith('[') ? one(param) : match?.[1];
    return id && viewId.test(id) ? `${name}/${id}` : null;
  };
  if (path === '/terminal/worker') {
    const worker = location.workerSelection;
    if (!worker?.nodeId || !worker.session || !worker.target) return null;
    return route('terminal', {
      worker: JSON.stringify({
        nodeId: worker.nodeId,
        session: worker.session,
        target: worker.target,
        ...(worker.window ? { window: worker.window } : {}),
        ...(worker.windowName ? { windowName: worker.windowName } : {}),
        ...(worker.pane ? { pane: worker.pane } : {}),
        ...(worker.paneId ? { paneId: worker.paneId } : {}),
      }),
    });
  }
  if (location.artifactSelection) {
    const {
      runId,
      slotId,
      recipeRunId,
      path: artifact,
      criterionId,
      traceIndex,
    } = location.artifactSelection;
    if (
      !viewId.test(runId) ||
      !artifact ||
      artifact.startsWith('/') ||
      /[\\\u0000-\u001f]/.test(artifact) ||
      /^[a-z][a-z0-9+.-]*:/i.test(artifact) ||
      artifact.split('/').includes('..')
    )
      return null;
    if (recipeRunId) {
      if (criterionId || traceIndex !== undefined) return null;
      if (
        !slotId ||
        !viewId.test(slotId) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(recipeRunId)
      )
        return null;
      return route(`slot/${slotId}`, {
        runId,
        recipeRun: recipeRunId,
        recipeArtifact: artifact,
        recipeViewer: '1',
        reviewDrawer: 'recipe',
      });
    }
    if (traceIndex !== undefined && (!Number.isSafeInteger(traceIndex) || traceIndex < 0))
      return null;
    return route(`run/${runId}`, {
      panel: 'evidence',
      tab: 'evidence',
      artifactRun: runId,
      artifact,
      artifactAc: criterionId ?? '',
      artifactTrace: traceIndex?.toString() ?? '',
    });
  }
  const run = entity(/^\/run\/([^/]+)$/, 'run', 'id');
  if (run) return route(run);
  const workspaceRun = entity(
    /^\/workspace\/run\/([^/]+)\/(timeline|evidence|files|diff|gate)$/,
    'run',
    'runId',
  );
  if (workspaceRun) {
    const tab = path.slice(path.lastIndexOf('/') + 1);
    // These views have a dedicated selected artifact/decision on the web.
    if (tab === 'files' || tab === 'diff') return null;
    if (tab === 'gate')
      return one('decisionId') ? route('decisions', { gate: one('decisionId') }) : null;
    return route(workspaceRun, {
      panel: tab,
      tab: tab === 'evidence' ? 'evidence' : '',
      recipeRun: one('recipeRun'),
      artifact: one('artifact'),
    });
  }
  const family = entity(/^\/family\/([^/]+)$/, 'family', 'familyId');
  if (family) {
    const evidence = one('evidence');
    if (evidence && !['all', 'before', 'after', 'setup', 'videos'].includes(evidence)) return null;
    return route(family, { run: one('runId'), evidence: evidence === 'all' ? '' : evidence });
  }
  const slot =
    entity(/^\/slot\/([^/]+)$/, 'slot', 'id') ??
    entity(/^\/workspace\/slot\/([^/]+)\/slot$/, 'slot', 'slotId');
  if (slot) return location.params.runId ? null : route(slot);
  const terminal =
    entity(/^\/terminal\/([^/]+)$/, 'terminal', 'slotId') ??
    entity(/^\/workspace\/slot\/([^/]+)\/terminal$/, 'terminal', 'slotId');
  if (terminal && terminal !== 'terminal/worker') {
    if (location.params.runId || one('contextId')) return null;
    return route(terminal);
  }
  const runTerminal = entity(/^\/run-terminal\/([^/]+)$/, 'run', 'runId');
  if (runTerminal) return null;
  const decision = entity(/^\/(?:decision|gate-review)\/([^/]+)$/, 'decision', 'id');
  if (decision) return route('decisions', { gate: decision.slice('decision/'.length) });
  const backlog = entity(/^\/backlog\/([^/]+)$/, 'backlog', 'id');
  if (backlog && backlog !== 'backlog/create')
    return route('backlog', { item: backlog.slice('backlog/'.length) });
  const backlogEdit = entity(/^\/backlog\/edit\/([^/]+)$/, 'backlog', 'id');
  if (backlogEdit)
    return route('backlog', { item: backlogEdit.slice('backlog/'.length), mode: 'edit' });
  if (path === '/backlog/create') return route('backlog', { create: '1' });
  const roadmap = entity(/^\/roadmap\/([^/]+)$/, 'roadmap', 'id');
  if (roadmap) return route('roadmap', { item: roadmap.slice('roadmap/'.length) });
  if (path === '/native') {
    const sessionId = one('sessionId');
    const executionNodeId = one('executionNodeId');
    return sessionId && executionNodeId && viewId.test(sessionId) && viewId.test(executionNodeId)
      ? route('native', { sessionId, executionNodeId })
      : null;
  }
  if (path === '/runs') {
    const selection = location.runFilters;
    return route('runs', {
      runsTab: location.runsTab ?? '',
      flow: selection?.flow ?? '',
      lane: selection?.lane ?? '',
      sort: selection?.sort === 'newest' ? '' : (selection?.sort ?? ''),
      q: selection?.search ?? '',
      tag: selection?.tag ?? '',
    });
  }
  if (path === '/backlog')
    return route('backlog', {
      backlogStatus: BACKLOG_STATUSES.filter(
        (status) => status !== 'done' && status !== 'archived',
      ).join(','),
      sort: 'status',
      direction: 'asc',
    });
  if (path === '/prs') {
    if (one('nativeFilter') && one('nativeFilter') !== 'all') return null;
    return route('prs', {
      pr: one('pr'),
      repo: one('repo'),
      prSort: one('prSort') || 'group',
      prScope: 'all',
      prHistory: '1',
    });
  }
  if (
    path === '/roadmap' &&
    ((one('nativeStage') && one('nativeStage') !== 'all') ||
      (one('nativeDelivery') && one('nativeDelivery') !== 'all') ||
      one('nativeSearch') ||
      one('nativeDelivered') === '1')
  )
    return null;
  const collections: Readonly<Record<string, string>> = {
    '/fleet': 'fleet',
    '/inbox': 'decisions',
    '/roadmap': 'roadmap',
  };
  return collections[path] ? route(collections[path]) : null;
}

/** One mapping for Companion generation and Command Center receipt. */
export function resolveSharedViewLink(
  location: SharedViewLocation,
  commandCenterUrl?: string,
): SharedViewLink {
  if (!commandCenterUrl?.trim()) return unavailable(noWebUrl, 'web-url-unset');
  const error = commandCenterUrlError(commandCenterUrl.trim());
  if (error) return unavailable(`Web link unavailable: ${error}`, 'invalid-web-url');
  const base = new URL(commandCenterUrl.trim());
  let candidate: string | null;
  if ('companion' in location) {
    if (location.companion.unavailableMessage)
      return unavailable(location.companion.unavailableMessage);
    if (location.companion.pathname === '/native') {
      if (location.companion.params.workerManaged === '1')
        return unavailable('Web link unavailable: task conversations have no exact web route yet.');
      if (location.companion.params.sessionObserved !== '1')
        return unavailable('Web link unavailable: select a loaded conversation.');
    }
    candidate = companionViewRoute(location.companion);
  } else if ('route' in location) candidate = location.route;
  else {
    try {
      const incoming = new URL(location.url);
      if (
        incoming.origin !== base.origin ||
        incoming.pathname !== base.pathname ||
        incoming.search ||
        incoming.username ||
        incoming.password
      )
        return unavailable(
          'Web link unavailable: this view belongs to another deployment.',
          'invalid-view',
        );
      candidate = incoming.hash;
    } catch {
      return unavailable('Web link unavailable: invalid view URL.', 'invalid-view');
    }
  }
  if (!candidate) {
    const path = 'companion' in location ? location.companion.pathname : '';
    const pinnedSlot =
      'companion' in location &&
      /^(?:\/slot\/[^/]+|\/workspace\/slot\/[^/]+\/slot)$/.test(path) &&
      location.companion.params.runId;
    const pinnedTerminal =
      'companion' in location &&
      /^(?:\/terminal\/[^/]+|\/workspace\/slot\/[^/]+\/terminal)$/.test(path) &&
      location.companion.params.runId;
    const view = pinnedSlot
      ? 'this pinned slot view'
      : pinnedTerminal
        ? 'this pinned slot terminal'
        : path.startsWith('/run-terminal/')
          ? 'this run terminal'
          : path.includes('diff')
            ? 'this diff selection'
            : path.includes('/files') || path.includes('/artifacts')
              ? 'this files view'
              : path === '/terminal/worker'
                ? 'this worker terminal'
                : path === '/settings' || path === '/connection'
                  ? 'these device connection settings'
                  : path === '/prs'
                    ? 'this PR filter'
                    : path === '/roadmap'
                      ? 'this roadmap filter'
                      : path === '/copilot'
                        ? 'this Co-Pilot screen'
                        : path === '/pr-automation'
                          ? 'this PR automation screen'
                          : path === '/unmapped-overlay'
                            ? 'this dialog'
                            : 'this screen';
    return unavailable(`Web link unavailable: ${view} has no exact Command Center view.`);
  }
  if (!validViewRoute(candidate))
    return unavailable('Web link unavailable: invalid view selection.', 'invalid-view');
  const [path, query = ''] = candidate.split('?');
  const params = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (privateSelectors.has(key) || seen.has(key))
      return unavailable('Web link unavailable: this selection cannot be shared.', 'invalid-view');
    seen.add(key);
  }
  const route = withoutSharedViewMarker(candidate);
  params.set('sharedView', '1');
  base.hash = `${path}${params.toString() ? `?${params}` : ''}`;
  return { status: 'available', route, url: base.href };
}

export interface SharedViewDeployment {
  commandCenterUrl?: string;
  gatewayUrls: readonly string[];
}

export type SharedViewReceipt =
  | { status: 'ordinary' }
  | { status: 'accepted'; route: string }
  | { status: 'refused'; message: string };

/** The marker is consumed before a marked route may read from a gateway. */
export function receiveSharedViewLink(
  url: string,
  gatewayUrl: string,
  deployment: SharedViewDeployment,
): SharedViewReceipt {
  let incoming: URL;
  try {
    incoming = new URL(url);
  } catch {
    return { status: 'refused', message: 'Web link unavailable: invalid view URL.' };
  }
  const selectors = new URLSearchParams(incoming.hash.split('?')[1] ?? '');
  if (!selectors.has('sharedView')) return { status: 'ordinary' };
  if (selectors.getAll('sharedView').length !== 1 || selectors.get('sharedView') !== '1')
    return { status: 'refused', message: 'Web link unavailable: invalid shared view.' };
  const selected = normalizeSharedGatewayUrl(gatewayUrl);
  const configured = deployment.gatewayUrls.map(normalizeSharedGatewayUrl);
  if (
    !selected ||
    !configured.length ||
    configured.some((value) => !value) ||
    !configured.includes(selected)
  )
    return {
      status: 'refused',
      message: 'Web link unavailable: the selected gateway does not match this deployment.',
    };
  const resolved = resolveSharedViewLink({ url }, deployment.commandCenterUrl);
  return resolved.status === 'available'
    ? { status: 'accepted', route: resolved.route }
    : { status: 'refused', message: resolved.message };
}

function normalizeSharedGatewayUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !['ws:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}
