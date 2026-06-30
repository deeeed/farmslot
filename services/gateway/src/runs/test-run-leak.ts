// Detects gateway unit-test fixtures that leaked into the production .runs/ dir.
// Shapes mirror services/gateway/src/methods/run.test.ts publish/evidence drift tests.

import type { Run, RunCreateParams } from '@farmslot/protocol';

const DRIFT_TICKET = /^(?:PUBLISH|EVIDENCE)-DRIFT-[0-9A-F]+$/i;
const DRIFT_TASK_DIR = /farmslot-(?:package|evidence)-drift-/;
const DRIFT_DECISION_IDS = new Set(['publish-gate-drift', 'publish-gate-evidence-drift']);
const DRIFT_INITIAL_CONTEXT = /^Exercise (?:current package|selected evidence) drift approval$/;

function ticketLooksLikeDriftFixture(ticket: string | null | undefined): boolean {
  return typeof ticket === 'string' && DRIFT_TICKET.test(ticket);
}

function taskPathLooksLikeDriftFixture(taskPath: string | null | undefined): boolean {
  return typeof taskPath === 'string' && DRIFT_TASK_DIR.test(taskPath);
}

function initialContextLooksLikeDriftFixture(context: string | null | undefined): boolean {
  return typeof context === 'string' && DRIFT_INITIAL_CONTEXT.test(context);
}

export function isLeakedGatewayTestRun(run: Run): boolean {
  if (ticketLooksLikeDriftFixture(run.ticketOrPr)) return true;
  if (ticketLooksLikeDriftFixture(run.familyRootTicketOrPr)) return true;
  if (taskPathLooksLikeDriftFixture(run.taskFile)) return true;
  if (taskPathLooksLikeDriftFixture(run.activeTaskFile)) return true;
  if ((run.decisions ?? []).some((decision) => DRIFT_DECISION_IDS.has(decision.id))) {
    return true;
  }
  const initialContext = run.engineState?.interactiveDev?.initialContext;
  if (initialContextLooksLikeDriftFixture(initialContext)) return true;
  return false;
}

export function isLeakedGatewayTestFixture(
  params: Pick<RunCreateParams, 'ticketOrPr' | 'familyRootTicketOrPr' | 'initialContext'>,
): boolean {
  if (ticketLooksLikeDriftFixture(params.ticketOrPr)) return true;
  if (ticketLooksLikeDriftFixture(params.familyRootTicketOrPr)) return true;
  if (initialContextLooksLikeDriftFixture(params.initialContext)) return true;
  return false;
}
