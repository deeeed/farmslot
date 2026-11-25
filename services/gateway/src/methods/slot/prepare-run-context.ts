import type { Run, SlotPrepareParams } from '@farmslot/protocol';

/**
 * A prepare for a run (it names `runId` or `bindRunId`) takes that run's flow type, domain and app
 * where the caller left them out, so every part of prepare reads the run's context: start-ref
 * policy, lockfile drift, requirement and profile selection, fixtures and the hook env. Explicit
 * params still win. A prepare for no run, or for a run that no longer exists, is left as it is.
 */
export function withRunPrepareContext(
  params: SlotPrepareParams,
  run: Pick<Run, 'flowType' | 'domain' | 'app'> | undefined,
): SlotPrepareParams {
  if (!run) return params;
  return {
    ...params,
    ...(params.flowType === undefined && run.flowType ? { flowType: run.flowType } : {}),
    ...(params.domain === undefined && run.domain ? { domain: run.domain } : {}),
    ...(params.app === undefined && run.app ? { app: run.app } : {}),
  };
}
