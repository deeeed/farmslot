import { Redirect } from 'expo-router';

import { useWorkspaceRenderAccess } from '../lib/use-workspace-render-access';
import { workspaceHome } from '../lib/workspace-access';
import { useConnectionStore } from '../store/connection';

export default function Index() {
  const access = useWorkspaceRenderAccess();
  const status = useConnectionStore((state) => state.status);
  const client = useConnectionStore((state) => state.client);
  const initializing = useConnectionStore((state) => state.initializing);
  if (!client || initializing || (status === 'connecting' && access === 'none')) return null;
  return <Redirect href={workspaceHome(access)} />;
}
