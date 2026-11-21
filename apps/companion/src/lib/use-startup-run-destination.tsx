import { useNetworkState } from 'expo-network';
import {
  type Href,
  useIsFocused,
  usePathname,
  useRouter,
  useUnstableGlobalHref,
} from 'expo-router';
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useConnectionStore } from '../store/connection';

import { getResourceNativeOwnerId } from './resource-cache';
import {
  pendingStartupRunDestination,
  resolveStartupRunDestination,
  startupFallbackAccess,
} from './startup-run-destination';
import { type WorkspaceAccess, workspaceHome } from './workspace-access';

const StartupDestination = createContext<ReturnType<typeof pendingStartupRunDestination>>(null);

export function StartupRunDestinationProvider({ children }: PropsWithChildren) {
  const href = useUnstableGlobalHref();
  const pathname = usePathname();
  const [destination, setDestination] = useState(() => pendingStartupRunDestination(href));
  const reachedIndex = useRef(false);
  useEffect(() => {
    if (pathname === '/') reachedIndex.current = true;
    else if (reachedIndex.current) setDestination(null);
  }, [pathname]);
  return <StartupDestination.Provider value={destination}>{children}</StartupDestination.Provider>;
}

/** The unprotected index resumes only after live authority, or gives up to the safe home. */
export function useStartupRunRedirect(rememberedAccess: WorkspaceAccess): boolean {
  const destination = useContext(StartupDestination);
  const router = useRouter();
  const focused = useIsFocused();
  const network = useNetworkState();
  const authority = useConnectionStore(
    useShallow((state) => ({
      startupWorkspace: state.startupWorkspace,
      gatewayUrl: state.gatewayUrl,
      profileId: state.activeProfileId,
      principalId: state.principalId,
      status: state.status,
      signedOut: state.signedOut,
      workspaceAccess: state.workspaceAccess,
      refused:
        state.client?.resourceConnectionReason === 'credential-refused' ||
        state.client?.resourceConnectionReason === 'session-ended' ||
        (state.client !== null && !state.gatewayUrl),
      offline:
        network.isConnected === false ||
        (state.status === 'disconnected' && state.client?.resourceConnectionReason === 'network'),
    })),
  );
  const resolved = destination && resolveStartupRunDestination(destination.href, authority);
  const target =
    resolved === null
      ? workspaceHome(
          startupFallbackAccess(authority, {
            access: rememberedAccess,
            principalId: getResourceNativeOwnerId(),
          }),
        )
      : resolved;
  useEffect(() => {
    if (focused && destination && target && destination.claim()) router.replace(target as Href);
  }, [destination, focused, router, target]);
  return destination !== null;
}
