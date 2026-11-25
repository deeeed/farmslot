import { shellQuote } from '../../core/tmux.js';

/**
 * The context a prepare's deps, preflight, health and unlock hooks see, as shell commands: the
 * selected profile and the flow type. A project script can then branch on what the prepare is for
 * (a dev run's runtime vs a review's checkout) instead of declaring per-profile hooks. A flowless
 * prepare (recycle, keep-warm release) unsets the flow type, so a value inherited from the
 * gateway's environment never reaches the hook.
 */
export function prepareHookEnvExports(profile: string, flowType?: string): string[] {
  return [
    `export FARMSLOT_PREPARE_PROFILE=${shellQuote(profile)}`,
    flowType ? `export FARMSLOT_FLOW_TYPE=${shellQuote(flowType)}` : 'unset FARMSLOT_FLOW_TYPE',
  ];
}
