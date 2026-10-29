import { configurationProjectsQuery } from '../lib/gateway-run-sync';
import { useWorkspaceRenderAccess } from '../lib/use-workspace-render-access';

import { useResourceQuery } from './useResourceQuery';

export { configurationProjectsQuery };

/** Render the current farm owner's saved project registration, including cold offline state. */
export function useConfigurationProjects() {
  const access = useWorkspaceRenderAccess();
  return useResourceQuery(access === 'farm' ? configurationProjectsQuery : undefined);
}
