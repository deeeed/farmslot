import { type ConfigProjectsResult, Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useWorkspaceRenderAccess } from '../lib/use-workspace-render-access';

import { useResourceQuery } from './useResourceQuery';

export const configurationProjectsQuery = resourceQuery<ConfigProjectsResult>(
  Methods.CONFIG_PROJECTS,
);

/** Render the current farm owner's saved project registration, including cold offline state. */
export function useConfigurationProjects() {
  const access = useWorkspaceRenderAccess();
  return useResourceQuery(access === 'farm' ? configurationProjectsQuery : undefined);
}
