import {
  isRuntimeCapabilityProofMode,
  isTerminalRunStatus,
  recipeFlowRequirements,
  type Run,
  type RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { getRuntimeCapabilityRegistry } from '../methods/runtime-capabilities.js';
import { getRun } from '../runs/store.js';
import { sameCapabilityParameters } from '../runtime-capabilities/parameters.js';
import {
  projectUsesExecutionTemplateCatalog,
  readConfiguredExecutionTemplateSnapshot,
  resolveConfiguredExecutionTemplateForSlot,
} from '../tasks/execution-template-catalog.js';
import {
  assertRecipeDispatchRequirements,
  checkRecipeDispatchRequirements,
} from '../tasks/recipe-dispatch-check.js';

import { BlockedRunError } from './errors.js';
import {
  prepareRunPostureForValidation,
  type PrepareRunPostureOutcome,
} from './resource-posture.js';
import { runSupersededSince } from './run-generation.js';

interface DeclaredCapabilityDeps {
  getRun: (runId: string) => Run | undefined;
  status: (slotId: string) => Promise<RuntimeCapabilityStatusResult>;
  prepare: typeof prepareRunPostureForValidation;
}

/** Consume provider IDs and the registry's authored plan; never derive acquire inputs from smoke params. */
export async function prepareDeclaredRunCapabilities(
  runId: string,
  resources: readonly string[],
  deps: DeclaredCapabilityDeps = {
    getRun,
    status: (slotId) => getRuntimeCapabilityRegistry().status({ slotId }),
    prepare: prepareRunPostureForValidation,
  },
): Promise<PrepareRunPostureOutcome> {
  if (resources.length === 0) return { ok: true };
  const run = deps.getRun(runId);
  if (!run?.slotId)
    return { ok: false, reason: 'Declared resources require an assigned run owner.' };
  const slotId = run.slotId;
  const generation = run.engineState?.generation ?? 0;
  const current = (): boolean => {
    const latest = deps.getRun(runId);
    return Boolean(
      latest &&
      latest.slotId === slotId &&
      !runSupersededSince(latest, generation) &&
      !latest.archivedAt &&
      !isTerminalRunStatus(latest.status),
    );
  };
  const superseded = (): PrepareRunPostureOutcome => ({
    ok: false,
    reason: 'Declared capability preparation was superseded; worker delivery is refused.',
  });
  if (!current()) return superseded();
  const status = await deps.status(slotId);
  if (!current()) return superseded();
  const plan = status.proofPlans[runId];
  if (plan && (plan.ownerRunId !== runId || plan.slotId !== slotId))
    return { ok: false, reason: 'The authored proof plan belongs to another run or slot.' };

  for (const capabilityId of new Set(resources)) {
    const matches = plan?.requirements.filter((item) => item.capabilityId === capabilityId) ?? [];
    if (matches.length !== 1 || !isRuntimeCapabilityProofMode(matches[0]?.mode)) {
      return {
        ok: false,
        reason:
          `Declared capability '${capabilityId}' requires one authored proof mode in this run's ` +
          'existing proof plan. The declaration owner must supply it before dispatch.',
      };
    }
  }
  const requirements = structuredClone(
    plan!.requirements.filter((requirement) => resources.includes(requirement.capabilityId)),
  );
  for (const requirement of requirements) {
    if (!isRuntimeCapabilityProofMode(requirement.mode))
      return {
        ok: false,
        reason: `Capability '${requirement.capabilityId}' has no valid proof mode.`,
      };
    const held = status.leases.filter(
      (lease) =>
        lease.owner.runId === runId &&
        lease.capabilityId === requirement.capabilityId &&
        lease.state !== 'released',
    );
    if (
      held.some(
        (lease) => !sameCapabilityParameters(lease.parameters, requirement.parameters ?? {}),
      )
    )
      return {
        ok: false,
        reason:
          `Capability '${requirement.capabilityId}' has different frozen acquire parameters. ` +
          'Use the existing explicit target recovery before dispatch.',
      };
  }
  // Dependency parameters remain in the stored plan for the registry to consume.
  // The existing authority validates provider schemas and configured targets, orders
  // dependencies, revalidates health, and owns scoped contention/restart recovery.
  const outcome = await deps.prepare(runId, requirements);
  return current() ? outcome : superseded();
}

export function assertDeclaredCapabilityPreparation(outcome: PrepareRunPostureOutcome): void {
  if (!outcome.ok)
    throw new BlockedRunError(outcome.reason, outcome.waiting ? 'resource-wait' : outcome.reason);
}

/** Retained dispatch and fix delivery consume the same pinned selection as fresh dispatch. */
export async function prepareConfiguredRunCapabilities(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run?.slotId)
    throw new BlockedRunError('Declared capability preparation requires a run slot.');
  if (run.flowType === 'review-pr') return;
  const slot = await loadSlotVars(run.slotId);
  const project = await loadProjectVars(slot.projectName);
  if (!projectUsesExecutionTemplateCatalog(project)) return;
  const selected = run.executionTemplate
    ? readConfiguredExecutionTemplateSnapshot(project, {
        ...run.executionTemplate,
        flow: run.flowType,
      })
    : resolveConfiguredExecutionTemplateForSlot(project, {
        flow: run.flowType,
        platform: slot.platform,
        runMode: run.mode ?? 'autonomous',
        explicitDomain: run.domain,
        slotDomain: slot.domain,
      });
  assertRecipeDispatchRequirements(
    await checkRecipeDispatchRequirements(project, slot, selected.entry, {
      app: run.app,
      domain: run.domain ?? slot.domain,
    }),
  );
  assertDeclaredCapabilityPreparation(
    await prepareDeclaredRunCapabilities(
      runId,
      recipeFlowRequirements(selected.entry.frontmatter).resources,
    ),
  );
}
