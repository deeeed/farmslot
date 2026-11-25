import { shellQuote } from '../../core/tmux.js';

/**
 * The context every prepare hook sees, as shell exports: the selected profile and, when the prepare
 * belongs to a flow, its flow type. A project script can then branch on what the prepare is for
 * (a dev run's runtime vs a review's checkout) instead of declaring per-profile hooks.
 */
export function prepareHookEnvExports(profile: string, flowType?: string): string[] {
  return [
    `export FARMSLOT_PREPARE_PROFILE=${shellQuote(profile)}`,
    ...(flowType ? [`export FARMSLOT_FLOW_TYPE=${shellQuote(flowType)}`] : []),
  ];
}
