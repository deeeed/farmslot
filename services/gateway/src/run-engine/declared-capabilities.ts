import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseMarkdownDocument } from '@farmslot/agent-runtime';
import {
  EXECUTION_CHECKLIST_DOCUMENT,
  type ExecutionTemplateRunMode,
  isLightweightInteractiveDevRun,
  isTerminalRunStatus,
  recipeFlowRequirements,
  resolveRecipeProofRequirements,
  type Run,
  type RuntimeCapabilityProofRequirement,
  type RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars, type ProjectVars, type SlotVars } from '../core/config.js';
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

function frozenParameterRefusal(
  status: RuntimeCapabilityStatusResult,
  runId: string,
  requirements: readonly RuntimeCapabilityProofRequirement[],
): string | undefined {
  for (const requirement of requirements) {
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
      return `Capability '${requirement.capabilityId}' has different frozen acquire parameters. Use the existing explicit target recovery before dispatch.`;
  }
  return undefined;
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
  proofRequirements: readonly RuntimeCapabilityProofRequirement[] = [],
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
  let resolved;
  try {
    resolved = resolveRecipeProofRequirements({
      required: { resources: [...resources], proofRequirements: [...proofRequirements] },
      owner: { ownerRunId: runId, slotId },
      plan,
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (resolved.missingRequirements.length)
    return { ok: false, reason: resolved.diagnostics.join(' ') };
  const requirements = resolved.requirements;
  const refusal = frozenParameterRefusal(status, runId, requirements);
  if (refusal) return { ok: false, reason: refusal };
  // Dependency parameters remain in the stored plan for the registry to consume.
  // The existing authority validates provider schemas and configured targets, orders
  // dependencies, revalidates health, and owns scoped contention/restart recovery.
  const outcome = await deps.prepare(runId, requirements, undefined, {
    assertAdmissible: async () => {
      const latest = await deps.status(slotId);
      if (!current())
        throw new Error(
          'Declared capability preparation was superseded; worker delivery is refused.',
        );
      const refusal = frozenParameterRefusal(latest, runId, requirements);
      if (refusal) throw new Error(refusal);
    },
  });
  return current() ? outcome : superseded();
}

export function assertDeclaredCapabilityPreparation(outcome: PrepareRunPostureOutcome): void {
  if (!outcome.ok)
    throw new BlockedRunError(outcome.reason, outcome.waiting ? 'resource-wait' : outcome.reason);
}

/** Shared task APP fallback for fresh and warm dispatch callers. */
export function dispatchAppFromTask(requestedApp: string | undefined, taskContent: string): string {
  return requestedApp || taskContent.match(/^APP:\s*(\S+)/m)?.[1] || '';
}

interface DispatchCapabilityInput {
  run?: Run;
  project?: ProjectVars;
  slot: SlotVars;
  flow: string;
  mode: ExecutionTemplateRunMode;
  app?: string;
  assertCurrent?: () => void;
}

/** Fresh prepared dispatch has one selected-template/preflight/acquisition consumer. */
export async function prepareDispatchRunCapabilities(
  input: DispatchCapabilityInput,
): Promise<void> {
  const { run, project, slot, flow } = input;
  if (!project || !projectUsesExecutionTemplateCatalog(project) || flow === 'review-pr') return;
  const selected = run?.executionTemplate
    ? readConfiguredExecutionTemplateSnapshot(project, { ...run.executionTemplate, flow })
    : resolveConfiguredExecutionTemplateForSlot(project, {
        flow,
        platform: slot.platform,
        runMode: input.mode,
        explicitDomain: run?.domain,
        slotDomain: slot.domain,
      });
  assertRecipeDispatchRequirements(
    await checkRecipeDispatchRequirements(project, slot, selected.entry, {
      app: input.app,
      domain: run?.domain ?? slot.domain,
      runId: run?.id,
    }),
  );
  input.assertCurrent?.();
  const declared = recipeFlowRequirements(selected.entry.frontmatter);
  const resources = declared.resources;
  if (resources.length) {
    if (!run) throw new Error('Declared resources require a persisted run owner.');
    assertDeclaredCapabilityPreparation(
      await prepareDeclaredRunCapabilities(
        run.id,
        resources,
        undefined,
        declared.proofRequirements,
      ),
    );
    input.assertCurrent?.();
  }
}

/** A new warm/nudge task still consumes the same fresh-dispatch admission. */
export async function prepareConfiguredRunCapabilities(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run?.slotId)
    throw new BlockedRunError('Declared capability preparation requires a run slot.');
  if (run.flowType === 'review-pr') return;
  const slot = await loadSlotVars(run.slotId);
  await prepareDispatchRunCapabilities({
    run,
    slot,
    project: await loadProjectVars(slot.projectName),
    flow: run.flowType,
    mode: run.mode ?? 'autonomous',
    app:
      dispatchAppFromTask(run.app, run.taskFile ? await readFile(run.taskFile, 'utf8') : '') ||
      undefined,
  });
}

/** Existing execution consumes its authored plan, independent of later template edits. */
export async function prepareRetainedRunCapabilities(
  runId: string,
  deps: DeclaredCapabilityDeps = {
    getRun,
    status: (slotId) => getRuntimeCapabilityRegistry().status({ slotId }),
    prepare: prepareRunPostureForValidation,
  },
): Promise<void> {
  const run = deps.getRun(runId);
  if (!run?.slotId)
    throw new BlockedRunError('Declared capability preparation requires a run slot.');
  const status = await deps.status(run.slotId);
  if (!status.proofPlans[runId]?.requirements.length) return;
  if (!run.taskFile)
    throw new BlockedRunError(
      'Retained capability preparation requires the authored task snapshot.',
    );
  const document = isLightweightInteractiveDevRun(run)
    ? run.taskFile
    : path.join(path.dirname(run.taskFile), EXECUTION_CHECKLIST_DOCUMENT);
  const snapshot = await readFile(document, 'utf8');
  const declared = recipeFlowRequirements(parseMarkdownDocument(snapshot).frontmatter);
  assertDeclaredCapabilityPreparation(
    await prepareDeclaredRunCapabilities(
      runId,
      declared.resources,
      deps,
      declared.proofRequirements,
    ),
  );
}
