import { randomUUID } from 'node:crypto';

import {
  type FlowType,
  PR_BOUND_FLOW_TYPES,
  type RunCreateParams,
  type RunTicketData,
} from '@farmslot/protocol';

import { fetchTicketData } from '../../run-engine/ticket-data.js';
import { resolveRunLane } from '../../runs/store.js';
import { JIRA_KEY_RE, normalizeTicketRef, validateTicketRef } from '../dispatch/ticket-ref.js';

export function isInternalArtifactOnlyEvalTicket(
  params: Pick<
    RunCreateParams,
    'ticketOrPr' | 'flowType' | 'lane' | 'completionPolicy' | 'engineState'
  > & { taskFile?: string | null },
): boolean {
  return (
    (params.flowType === 'dev' || params.flowType === 'fix-bug') &&
    params.lane === 'comparison' &&
    params.completionPolicy === 'artifact-only' &&
    /^EVAL-[A-Z0-9][A-Z0-9-]{3,79}$/.test(params.ticketOrPr) &&
    (!!params.taskFile || !!params.engineState?.evalExperiment)
  );
}

export function isLocalDevRef(ticketOrPr: string): boolean {
  return /^DEV-[A-Z0-9][A-Z0-9-]*-[0-9A-F]{8}$/.test(ticketOrPr);
}

export function isManualBacklogRef(ticketOrPr: string): boolean {
  return /^MANUAL-\d+$/i.test(ticketOrPr);
}

/** Runs dispatched from Backlog keep MANUAL-* refs; replay must not re-validate them as direct dispatch. */
export function isStoredManualBacklogRun(
  run: Pick<RunCreateParams, 'flowType'> & {
    backlogItemId?: string | null;
    ticketOrPr: string;
  },
): boolean {
  return (
    Boolean(run.backlogItemId) &&
    isManualBacklogRef(run.ticketOrPr) &&
    !PR_BOUND_FLOW_TYPES.has(run.flowType as FlowType)
  );
}

/**
 * A production run for a Jira key, whose task Farmslot writes from the ticket,
 * starts from that ticket read through the project's Jira source: the caller's
 * copy when it was read from Jira for the same key (successor runs copy it),
 * else a fresh read that refuses instead of storing a key-only placeholder.
 * A caller-authored task file, and validation and comparison runs, keep the
 * caller's ticket.
 */
export async function jiraTicketDataForCreate(
  params: RunCreateParams,
): Promise<RunTicketData | undefined> {
  const ref = normalizeTicketRef(params.ticketOrPr);
  const key = ref.toUpperCase();
  if (
    !params.project ||
    params.taskFile ||
    resolveRunLane(params.mode, params.lane) !== 'production' ||
    params.flowType === 'qa' ||
    PR_BOUND_FLOW_TYPES.has(params.flowType as FlowType) ||
    isManualBacklogRef(key) ||
    !JIRA_KEY_RE.test(key)
  ) {
    return params.ticketData;
  }
  const supplied = params.ticketData;
  if (
    (supplied?.source === 'jira' || supplied?.source === 'both') &&
    supplied.jiraKey?.toUpperCase() === key
  ) {
    return supplied;
  }
  return (await fetchTicketData({ project: params.project, ticketOrPr: ref })) ?? undefined;
}

export function isValidTicketForFlow(
  ticketOrPr: string,
  flowType: RunCreateParams['flowType'],
): boolean {
  try {
    validateTicketRef(ticketOrPr, flowType);
    return true;
  } catch (_err) {
    // Interactive dev intentionally accepts operator-provided initial context and
    // normalizes it into a local DEV-* identity before validation.
    return false;
  }
}

export function buildLocalDevRef(initialContext: string): string {
  const slug =
    initialContext
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/g, '') || 'TASK';
  return `DEV-${slug}-${randomUUID().slice(0, 8).toUpperCase()}`;
}
