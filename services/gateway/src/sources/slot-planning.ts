import {
  type DispatchPreviewParams,
  ReviewQaConfigurationError,
  type Run,
  type SlotStatus,
} from '@farmslot/protocol';
import { type ProjectSourceContext, withProjectSources } from '@farmslot/slot-config';
import { assertSourceAttestation } from '@farmslot/slot-config/sources';

import type { SlotSelectionPlan, SlotSelectionRefusal } from '../methods/dispatch/slot-scoring.js';
import type { RunCreationPlan } from '../methods/run.js';

import type { SourceAuthority } from './authority.js';
import type { RunSourceAdmissionDependencies } from './run-admission.js';
import { captureRunSourceFence } from './run-fence.js';

export interface SourceSlotPlan extends SlotSelectionPlan {
  sources: ProjectSourceContext;
  run?: Run;
}

export interface SourceSlotRefusal extends SlotSelectionRefusal {
  configurationError?: ReviewQaConfigurationError;
}

export type SourceSlotPlans = ReadonlyMap<string, SourceSlotPlan | SourceSlotRefusal>;

export interface RunSlotSourcePlan extends SourceSlotPlan {
  run: Run;
}

export interface ProspectiveSlotSourcePlan extends SourceSlotPlan {
  creationPlan: RunCreationPlan;
}

export type RunSlotSourcePlans = Map<string, RunSlotSourcePlan | SourceSlotRefusal>;

/** A public preview's plan: run.create's own planning in the selected context, before any run. */
export function isProspectiveSlotSourcePlan(
  plan: SourceSlotPlan,
): plan is ProspectiveSlotSourcePlan {
  return 'creationPlan' in plan;
}

export type ProspectiveSlotSourcePlans = Map<string, ProspectiveSlotSourcePlan | SourceSlotRefusal>;

interface SourceContextPlanningDependencies {
  authority: Pick<SourceAuthority, 'lock'>;
  gatewayMaterialization: RunSourceAdmissionDependencies['gatewayMaterialization'];
}

export interface RunSlotPlanningDependencies extends SourceContextPlanningDependencies {
  getRun: RunSourceAdmissionDependencies['getRun'];
  replan: RunSourceAdmissionDependencies['replan'];
  params: (run: Run) => DispatchPreviewParams;
  projectConfigs: () => Promise<SlotSelectionPlan['projectConfigs']>;
}

function sourceContextLoader(
  project: string,
  runId: string | undefined,
  deps: SourceContextPlanningDependencies,
): (nodeId: string) => Promise<ProjectSourceContext> {
  const contexts = new Map<string, Promise<ProjectSourceContext>>();
  return (nodeId: string): Promise<ProjectSourceContext> => {
    let context = contexts.get(nodeId);
    if (!context) {
      context = (async () => {
        const lock = await deps.authority.lock({ project, ...(runId ? { runId } : {}), nodeId });
        if (
          lock.context.project !== project ||
          lock.context.runId !== runId ||
          lock.context.nodeId !== nodeId
        )
          throw new Error('Candidate source lock belongs to a different run or node');
        const materialization = await deps.gatewayMaterialization(lock);
        assertSourceAttestation(lock, 'gateway', materialization);
        return {
          project,
          pack: lock.packBindings[project],
          materialization,
          packs: lock.packBindings,
        };
      })();
      contexts.set(nodeId, context);
    }
    return context;
  };
}

async function collectSlotSourcePlans<T extends SourceSlotPlan>(
  project: string,
  slots: readonly Pick<SlotStatus, 'slot' | 'machine' | 'project'>[],
  forNode: (nodeId: string) => Promise<ProjectSourceContext>,
  plan: (
    slot: Pick<SlotStatus, 'slot' | 'machine' | 'project'>,
    sources: ProjectSourceContext,
  ) => Promise<T>,
): Promise<Map<string, T | SourceSlotRefusal>> {
  const plans = new Map<string, T | SourceSlotRefusal>();
  await Promise.all(
    slots
      .filter((slot) => slot.project === project)
      .map(async (slot) => {
        try {
          const sources = await forNode(slot.machine);
          plans.set(slot.slot, await withProjectSources(sources, () => plan(slot, sources)));
        } catch (error) {
          // Refusals stay per candidate; another node's verified closure can still be selected.
          plans.set(slot.slot, {
            refusal: (error as Error).message,
            ...(error instanceof ReviewQaConfigurationError ? { configurationError: error } : {}),
          });
        }
      }),
  );
  return new Map(
    slots
      .filter((slot) => slot.project === project)
      .map((slot) => [slot.slot, plans.get(slot.slot)!]),
  );
}

/** Inspect complete node closures without claiming a slot or publishing run provenance. */
export async function planRunSlotSources(
  run: Run,
  slots: readonly Pick<SlotStatus, 'slot' | 'machine' | 'project'>[],
  deps: RunSlotPlanningDependencies,
): Promise<RunSlotSourcePlans> {
  if (!run.sourcePlan || run.sourceProvenance)
    throw new Error('Run has no provisional source plan');
  const current = captureRunSourceFence(
    run,
    deps.getRun,
    'Run ownership or source plan changed while inspecting candidate nodes',
  );
  const forNode = sourceContextLoader(run.project, run.id, deps);
  const plans = await collectSlotSourcePlans(
    run.project,
    slots,
    forNode,
    async (slot, sources): Promise<RunSlotSourcePlan> => {
      const planned = await deps.replan(run, { nodeId: slot.machine, slotId: slot.slot });
      if (
        planned.id !== run.id ||
        planned.project !== run.project ||
        planned.sourcePlan?.lock.digest !== sources.materialization.lock.digest ||
        planned.sourcePlan.validatedSlotId !== slot.slot
      )
        throw new Error('Candidate planning returned a different run or source lock');
      return {
        run: planned,
        sources,
        params: deps.params(planned),
        projectConfigs: await deps.projectConfigs(),
      };
    },
  );
  current();
  return plans;
}

export interface ProspectiveSlotPlanningDependencies extends SourceContextPlanningDependencies {
  plan: (slotId: string) => Promise<RunCreationPlan>;
  params: (plan: RunCreationPlan) => DispatchPreviewParams;
  projectConfigs: RunSlotPlanningDependencies['projectConfigs'];
}

/** Preview/creation inputs are validated before any run ID, registry row or provenance exists. */
export async function planProspectiveSlotSources(
  project: string,
  slots: readonly Pick<SlotStatus, 'slot' | 'machine' | 'project'>[],
  deps: ProspectiveSlotPlanningDependencies,
  runId?: string,
): Promise<ProspectiveSlotSourcePlans> {
  const forNode = sourceContextLoader(project, runId, deps);
  return collectSlotSourcePlans(
    project,
    slots,
    forNode,
    async (slot, sources): Promise<ProspectiveSlotSourcePlan> => {
      const creationPlan = await deps.plan(slot.slot);
      if (
        creationPlan.params.project !== project ||
        creationPlan.params.slotId !== slot.slot ||
        creationPlan.workspaceAdmission
      )
        throw new Error('Prospective slot planning returned another project or placement');
      return {
        creationPlan,
        sources,
        params: deps.params(creationPlan),
        projectConfigs: await deps.projectConfigs(),
      };
    },
  );
}
