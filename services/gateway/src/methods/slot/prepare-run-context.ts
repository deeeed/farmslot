import type { Run, SlotPrepareParams } from '@farmslot/protocol';

/**
 * A prepare for a run (it names `runId` or `bindRunId`) takes that run's flow type, domain and app
 * where the caller left them out or blank, so every part of prepare reads the run's context:
 * start-ref policy, lockfile drift, requirement and profile selection, fixtures and the hook env.
 * Explicit params still win. A prepare for no run, or for a run not in the live store, is left as
 * it is.
 */
export function withRunPrepareContext(
  params: SlotPrepareParams,
  run: Pick<Run, 'flowType' | 'domain' | 'app'> | undefined,
): SlotPrepareParams {
  if (!run) return params;
  return {
    ...params,
    ...(!params.flowType?.trim() && run.flowType ? { flowType: run.flowType } : {}),
    ...(!params.domain?.trim() && run.domain ? { domain: run.domain } : {}),
    ...(!params.app?.trim() && run.app ? { app: run.app } : {}),
  };
}

/**
 * A slot is prepared only for a run of its own project: another project's flow, domain and app
 * would otherwise reach its fixtures and slot status before the bind refuses the run.
 */
export function assertRunMatchesSlotProject(
  run: Pick<Run, 'id' | 'project'>,
  slotId: string,
  slotProject: string,
): void {
  if (run.project && slotProject && run.project !== slotProject)
    throw new Error(
      `Run ${run.id.slice(0, 8)} belongs to project ${run.project}, not ${slotId}'s project ${slotProject}; refusing to prepare the slot for it`,
    );
}
