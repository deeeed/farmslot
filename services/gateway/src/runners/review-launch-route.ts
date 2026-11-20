import type { AgentContext } from '@farmslot/protocol';

/** What a static reviewer's launch receipt recorded about the LiteLLM route its runner took. */
export interface LaunchRouteReceipt {
  liteLlmEndpointId?: string;
  liteLlmRouteUnverified?: boolean;
}

type LaunchRoute = Pick<AgentContext, 'launchLiteLlmEndpointId' | 'launchLiteLlmRouteUnverified'>;

/** Both fields, always written, so a launch clears what an earlier one recorded. */
export interface LaunchRouteFields {
  launchLiteLlmEndpointId: string | undefined;
  launchLiteLlmRouteUnverified: AgentContext['launchLiteLlmRouteUnverified'];
}

/**
 * The route a reviewer context records for its transcript after a launch. A fresh transcript takes
 * the launch's route. A continued transcript keeps its earlier turns' route: the same verified
 * route stays verified, while another route, an unknown one, or earlier turns with none recorded
 * leave the transcript unverified for good, so no later price applies to earlier turns. Neither
 * side recording a route keeps the context as it was before route receipts.
 */
export function launchLiteLlmRoute(
  receipt: LaunchRouteReceipt,
  prior: LaunchRoute | undefined,
  continued: boolean,
): LaunchRouteFields {
  const route = (
    launchLiteLlmEndpointId: string | undefined,
    launchLiteLlmRouteUnverified?: LaunchRoute['launchLiteLlmRouteUnverified'],
  ): LaunchRouteFields => ({ launchLiteLlmEndpointId, launchLiteLlmRouteUnverified });
  const launched = receipt.liteLlmEndpointId || undefined;
  const recorded = Boolean(launched || receipt.liteLlmRouteUnverified);
  if (!continued) {
    if (launched) return route(launched);
    return recorded ? route(undefined, 'unknown-route') : route(undefined);
  }
  if (prior?.launchLiteLlmRouteUnverified)
    return route(undefined, prior.launchLiteLlmRouteUnverified);
  const earlier = prior?.launchLiteLlmEndpointId;
  if (!earlier) return recorded ? route(undefined, 'unknown-route') : route(undefined);
  if (!launched) return route(undefined, 'unknown-route');
  return launched === earlier ? route(launched) : route(undefined, 'mixed-routes');
}
