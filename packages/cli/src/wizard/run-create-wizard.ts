// run-create-wizard.ts — guided TTY picker for `farmslot run create` /
// `farmslot dispatch` when required args are missing. Collects the same
// parameters the flags express and dispatches through the same RPCs — no
// forked business rules. Machine mode never reaches this module.

import {
  type BacklogItem,
  type ConfigProjectsResult,
  type FleetStatusResult,
  selectSlot,
  slotSelectionScore,
  slotUnavailableReason,
} from '@farmslot/protocol';

import type { GatewayClient } from '../gateway-client.js';

const FLOW_TYPES = ['dev', 'fix-bug', 'review-pr', 'pr-complete'] as const;

export interface WizardDispatchPlan {
  kind: 'ticket' | 'backlog';
  project: string;
  flowType?: string;
  ticket?: string;
  backlogItemId?: string;
  backlogRef?: string;
  slotId?: string;
}

/**
 * Interactive collection of a dispatch plan. Returns null when the operator
 * cancels. Throws GatewayRpcError etc. from the underlying RPCs unchanged.
 */
export async function collectRunCreatePlan(
  client: GatewayClient,
): Promise<WizardDispatchPlan | null> {
  const prompts = await import('@clack/prompts');
  prompts.intro('farmslot dispatch');

  const projectsResult = await client.call<ConfigProjectsResult>('config.projects');
  const projectNames = projectsResult.projects.map((project) => project.name);
  if (projectNames.length === 0) {
    // Not a cancellation: surface a real failure (non-zero exit) with the fix.
    throw Object.assign(new Error('No projects registered.'), {
      code: 'NO_PROJECTS_REGISTERED',
      userAction: 'Register a pack first: `farmslot project add <path-or-git-url>`.',
    });
  }
  const project = await prompts.select({
    message: 'Project',
    options: projectNames.map((name) => ({ value: name, label: name })),
  });
  if (prompts.isCancel(project)) return cancelled(prompts);

  const backlogResult = await client.call<{ items: BacklogItem[] }>('backlog.list');
  const dispatchable = backlogResult.items.filter(
    (item) => item.project === project && (item.status === 'candidate' || item.status === 'ready'),
  );

  const source = await prompts.select({
    message: 'What should the run work on?',
    options: [
      ...(dispatchable.length > 0
        ? [{ value: 'backlog', label: `Backlog item (${dispatchable.length} dispatchable)` }]
        : []),
      { value: 'ticket', label: 'Ticket / PR ref (Jira key, GitHub issue/PR URL or ref)' },
    ],
  });
  if (prompts.isCancel(source)) return cancelled(prompts);

  const plan: WizardDispatchPlan = { kind: source as 'ticket' | 'backlog', project };

  if (source === 'backlog') {
    const itemId = await prompts.select({
      message: 'Backlog item',
      options: dispatchable.map((item) => ({
        value: item.id,
        label: `${item.sourceRef ?? item.id.slice(0, 8)} [${item.status}] ${item.title.slice(0, 60)}`,
      })),
    });
    if (prompts.isCancel(itemId)) return cancelled(prompts);
    const item = dispatchable.find((candidate) => candidate.id === itemId);
    plan.backlogItemId = String(itemId);
    plan.backlogRef = item?.sourceRef ?? String(itemId);
  } else {
    const ticket = await prompts.text({
      message: 'Ticket / PR ref',
      placeholder: 'e.g. PROJ-123 or owner/repo#456',
      validate: (value) => (value?.trim() ? undefined : 'A ref is required.'),
    });
    if (prompts.isCancel(ticket)) return cancelled(prompts);
    plan.ticket = String(ticket).trim();

    const flowType = await prompts.select({
      message: 'Flow type',
      options: FLOW_TYPES.map((flow) => ({ value: flow, label: flow })),
    });
    if (prompts.isCancel(flowType)) return cancelled(prompts);
    plan.flowType = String(flowType);
  }

  // Slot: auto-pick via the shared selection core, overridable. Backlog
  // dispatch picks its own slot at tick time, so only the ticket route asks.
  if (plan.kind === 'ticket') {
    const status = await client.call<FleetStatusResult>('fleet.status');
    const picked = selectSlot(status.fleet, { project });
    const available = status.fleet.stale
      ? []
      : status.fleet.slots.filter(
          (slot) => slot.project === project && slotUnavailableReason(slot) === null,
        );
    if (picked.ok) {
      const slotChoice = await prompts.select({
        message: 'Slot',
        options: [
          { value: '', label: `auto — best available (${picked.slot.slot})` },
          ...available.map((slot) => ({
            value: slot.slot,
            label: `${slot.slot} (score ${slotSelectionScore(slot)})`,
          })),
        ],
      });
      if (prompts.isCancel(slotChoice)) return cancelled(prompts);
      if (slotChoice) plan.slotId = String(slotChoice);
    } else {
      prompts.log.warn(`${picked.reason} The gateway will pick a slot at dispatch time.`);
    }
  }

  const summary =
    plan.kind === 'backlog'
      ? `Dispatch backlog item ${plan.backlogRef} on ${plan.project}`
      : `Create ${plan.flowType} run for ${plan.ticket} on ${plan.project}${
          plan.slotId ? ` (slot ${plan.slotId})` : ' (auto slot)'
        }`;
  const confirmed = await prompts.confirm({ message: summary });
  if (prompts.isCancel(confirmed) || !confirmed) return cancelled(prompts);

  prompts.outro('Dispatching…');
  return plan;
}

function cancelled(prompts: { cancel: (message?: string) => void }): null {
  prompts.cancel('Cancelled — nothing dispatched.');
  return null;
}
