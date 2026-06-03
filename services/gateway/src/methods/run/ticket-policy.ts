import { randomUUID } from 'node:crypto';

import type { RunCreateParams } from '@farmslot/protocol';

import { validateTicketRef } from '../dispatch/ticket-ref.js';

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
  return /^MANUAL-\d+$/.test(ticketOrPr);
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
