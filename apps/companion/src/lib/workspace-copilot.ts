export interface WorkspaceCopilotDraftInput {
  current?: string | null;
  familyId?: string | null;
  slotId?: string | null;
  runId?: string | null;
  prNumber?: number | null;
  decisionId?: string | null;
  decisionKind?: string | null;
  workspaceFocus?: string | null;
  recipeRunId?: string | null;
  artifactPath?: string | null;
}

export type WorkspaceCopilotRouteParams = Record<string, string | string[] | undefined>;

export interface FailedStepDiagnosticDraftInput {
  runId: string;
  ticketOrPr: string;
  flowType: string;
  stepName: string;
  slotId?: string | null;
  stepDetail?: string | null;
}

export function buildWorkspaceCopilotDraft({
  current,
  familyId,
  slotId,
  runId,
  prNumber,
  decisionId,
  decisionKind,
  workspaceFocus,
  recipeRunId,
  artifactPath,
}: WorkspaceCopilotDraftInput): string {
  const contextParts = [
    current ? `screen=${current}` : null,
    slotId ? `slot=${slotId}` : null,
    runId ? `run=${shortContextId(runId)}` : null,
    familyId ? `family=${shortContextId(familyId)}` : null,
    prNumber ? `PR #${prNumber}` : null,
    decisionId ? `decision=${shortContextId(decisionId)}` : null,
    decisionKind ? `decisionKind=${decisionKind}` : null,
    workspaceFocus ? `focus=${workspaceFocus}` : null,
    recipeRunId ? `recipe=${recipeRunId}` : null,
    artifactPath ? `artifact=${artifactPath}` : null,
  ].filter((part): part is string => Boolean(part));

  const context = contextParts.length ? ` (${contextParts.join(', ')})` : '';
  return `Inspect the current mobile workspace${context}. Summarize what needs attention and propose the safest next action.`;
}

export function buildWorkspaceCopilotDraftForRoute(
  pathname: string,
  params: WorkspaceCopilotRouteParams,
): string {
  return buildWorkspaceCopilotDraft(workspaceCopilotInputForRoute(pathname, params));
}

export function workspaceCopilotInputForRoute(
  pathname: string,
  params: WorkspaceCopilotRouteParams,
): WorkspaceCopilotDraftInput {
  const decisionKind = routeParam(params.decisionKind) ?? routeParam(params.kind);
  const workspaceFocus = normalizeWorkspaceFocus(routeParam(params.workspace));
  const current = workspaceCopilotCurrentForRoute(
    pathname,
    routeParam(params.filter),
    decisionKind,
    workspaceFocus,
  );
  return {
    current,
    familyId: routeParam(params.familyId),
    slotId: routeParam(params.slotId) ?? routeParam(params.id, pathname.startsWith('/slot/')),
    runId: routeParam(params.runId) ?? routeParam(params.id, pathname.startsWith('/run/')),
    prNumber: parsePrNumber(routeParam(params.pr)),
    decisionId:
      routeParam(params.decisionId) ?? routeParam(params.id, pathname.startsWith('/decision/')),
    decisionKind,
    workspaceFocus,
    recipeRunId: routeParam(params.recipeRun),
    artifactPath: artifactPathForRoute(pathname, params),
  };
}

export function buildFailedStepDiagnosticDraft({
  runId,
  ticketOrPr,
  flowType,
  stepName,
  slotId,
  stepDetail,
}: FailedStepDiagnosticDraftInput): string {
  return [
    `Why did step "${stepName}" fail in run ${runId}?`,
    `Ticket or PR: ${ticketOrPr}`,
    `Flow: ${flowType}`,
    slotId ? `Slot: ${slotId}` : '',
    stepDetail ? `Step detail: ${stepDetail}` : '',
    'Call propose_run_recovery for this run and step first.',
    'Show the proposal finding, evidence, confidence, inference notes, and read-only next steps.',
  ]
    .filter(Boolean)
    .join('\n');
}

function shortContextId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 16)}…` : value;
}

function workspaceCopilotCurrentForRoute(
  pathname: string,
  artifactFilter: string | null,
  decisionKind: string | null,
  workspaceFocus: string | null,
): WorkspaceCopilotDraftInput['current'] {
  if (pathname.startsWith('/workspace/slot/')) {
    if (pathname.endsWith('/terminal')) return 'terminal';
    if (pathname.endsWith('/diff')) return 'diff';
    return 'slot';
  }
  if (pathname.startsWith('/workspace/run/')) {
    if (pathname.endsWith('/diff')) return 'diff';
    if (pathname.endsWith('/timeline')) return 'run';
    if (pathname.endsWith('/files')) {
      return (
        currentForArtifactFilter(artifactFilter, decisionKind) ?? workspaceFocus ?? 'artifacts'
      );
    }
    return workspaceFocus ?? workspaceCurrentForDecisionKind(decisionKind) ?? 'run';
  }
  if (pathname.startsWith('/slot/')) return 'slot';
  if (pathname.startsWith('/run/')) return 'run';
  if (pathname.startsWith('/family/')) return 'family';
  if (pathname.startsWith('/decision/')) {
    return workspaceCurrentForDecisionKind(decisionKind) ?? 'review';
  }
  if (pathname.startsWith('/terminal/')) return 'terminal';
  if (pathname.startsWith('/diff/')) return 'diff';
  if (pathname.startsWith('/artifacts/')) {
    return currentForArtifactFilter(artifactFilter, decisionKind) ?? 'artifacts';
  }
  if (pathname.startsWith('/prs')) return 'pr';
  if (pathname.startsWith('/runs')) return 'run';
  return null;
}

function currentForArtifactFilter(
  artifactFilter: string | null,
  decisionKind: string | null,
): WorkspaceCopilotDraftInput['current'] {
  if (artifactFilter === 'visual') return 'compare';
  if (artifactFilter === 'recipes') return 'recipe';
  if (artifactFilter === 'diffs') return 'diff';
  if (artifactFilter === 'review') {
    return workspaceCurrentForDecisionKind(decisionKind) ?? 'review';
  }
  return null;
}

function workspaceCurrentForDecisionKind(
  decisionKind: string | null,
): WorkspaceCopilotDraftInput['current'] {
  const normalized = decisionKind?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'ready') return 'ready';
  if (normalized === 'retrospective' || normalized === 'retro') return 'retro';
  if (normalized === 'review' || normalized === 'no-change' || normalized === 'no_change') {
    return 'review';
  }
  return null;
}

function normalizeWorkspaceFocus(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  const allowed = new Set([
    'artifacts',
    'compare',
    'copilot',
    'diff',
    'family',
    'pr',
    'ready',
    'recipe',
    'retro',
    'review',
    'run',
    'slot',
    'terminal',
  ]);
  return allowed.has(normalized) ? normalized : null;
}

function routeParam(value: string | string[] | undefined, enabled = true): string | null {
  if (!enabled) return null;
  const resolved = Array.isArray(value) ? value[0] : value;
  const normalized = resolved?.trim();
  return normalized || null;
}

function parsePrNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function artifactPathForRoute(
  pathname: string,
  params: WorkspaceCopilotRouteParams,
): string | null {
  const artifact = routeParam(params.artifact);
  if (artifact) return artifact;
  if (!pathname.startsWith('/diff/') && !pathname.includes('/diff')) return null;

  const path = routeParam(params.path);
  return path === pathname.replace(/^\/+/, '') ? null : path;
}
