import { html, nothing } from 'lit';

import type { AgentContext, Run } from '@farmslot/protocol';

export interface ReviewExecutionLocation {
  machine?: string;
  slotId?: string;
  workspaceId?: string;
  checkoutPath?: string;
  cleaned?: boolean;
  source: 'review-workspace' | 'slot';
}

type ReviewLocationRun = Pick<Run, 'reviewWorkspace' | 'reviewWorkspaceTarget' | 'agentContexts'>;
type LocationContext = Pick<AgentContext, 'slotId' | 'nativeSession' | 'executionLocation'>;

/** Use retained placement only; today's fleet checkout may belong to another run. */
export function reviewExecutionLocation(
  run: ReviewLocationRun,
  context?: LocationContext,
): ReviewExecutionLocation | undefined {
  const workspace = run.reviewWorkspace;
  if (workspace && !context?.slotId) {
    return {
      source: 'review-workspace',
      machine: workspace.machine,
      workspaceId: workspace.workspaceId,
      checkoutPath: workspace.checkoutPath,
      cleaned: Boolean(workspace.cleanedAt),
    };
  }
  const slotId = context?.slotId || undefined;
  const node = context?.nativeSession?.executionNodeId;
  const machine = context?.executionLocation?.machine ?? (node !== 'local' ? node : undefined);
  const checkoutPath = context?.executionLocation?.checkoutPath;
  if (!slotId && !machine) return undefined;
  return { source: 'slot', slotId, machine, checkoutPath };
}

export function reviewExecutionLocations(run: ReviewLocationRun): ReviewExecutionLocation[] {
  if (run.reviewWorkspace) return [reviewExecutionLocation(run)!];
  const locations = (run.agentContexts ?? [])
    .filter((context) => context.role === 'review')
    .flatMap((context) => {
      const location = reviewExecutionLocation(run, context);
      return location ? [location] : [];
    });
  return [...new Map(locations.map((location) => [JSON.stringify(location), location])).values()];
}

/** Same visible, selectable location in the header and each reviewer row. */
export function renderReviewExecutionLocation(location: ReviewExecutionLocation) {
  return html`<span
    data-testid="review-execution-location"
    data-machine=${location.machine ?? ''}
    data-slot=${location.slotId ?? ''}
    data-workspace=${location.workspaceId ?? ''}
    style="display:flex;flex-direction:column;gap:2px;min-width:0;max-width:100%;overflow-wrap:anywhere"
  >
    <span>${[location.machine, location.slotId].filter(Boolean).join(' · ')}</span>
    ${location.workspaceId
      ? html`<span
          >Workspace <code>${location.workspaceId}</code>${location.cleaned
            ? ' · cleaned'
            : nothing}</span
        >`
      : nothing}
    ${location.checkoutPath
      ? html`<code
          data-testid="review-checkout-path"
          title=${location.source === 'slot'
            ? 'Recorded worker checkout'
            : 'Recorded review checkout'}
          >${location.checkoutPath}</code
        >`
      : nothing}
  </span>`;
}
