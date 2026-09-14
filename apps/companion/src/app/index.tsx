import { Redirect } from 'expo-router';

import { workspaceHome } from '../lib/workspace-access';
import { useConnectionStore } from '../store/connection';

export default function Index() {
  const access = useConnectionStore((state) => state.workspaceAccess);
  const status = useConnectionStore((state) => state.status);
  const client = useConnectionStore((state) => state.client);
  const initializing = useConnectionStore((state) => state.initializing);
  if (!client || initializing || status === 'connecting') return null;
  return <Redirect href={workspaceHome(access)} />;
}
