import { type GatewayWorkspaceAccess as WorkspaceAccess, Methods } from '@farmslot/protocol';

export {
  type GatewayWorkspaceAccess as WorkspaceAccess,
  workspaceAccessFromAuth,
} from '@farmslot/protocol';

const nativeMethods = new Set<string>([
  Methods.GATEWAY_PING,
  Methods.NATIVE_PROFILE_LIST,
  Methods.NATIVE_PROFILE_ADD,
  Methods.NATIVE_PROFILE_STATUS,
  Methods.NATIVE_PROFILE_REMOVE,
  Methods.NATIVE_SESSION_CATALOG,
  Methods.NATIVE_SESSION_LIST,
  Methods.NATIVE_SESSION_CREATE,
  Methods.NATIVE_SESSION_ENSURE,
  Methods.NATIVE_SESSION_READ,
  Methods.NATIVE_SESSION_SEND,
  Methods.NATIVE_SESSION_RESPOND,
  Methods.NATIVE_SESSION_INTERRUPT,
  Methods.NATIVE_SESSION_CLOSE,
  Methods.NATIVE_SESSION_WORKSPACE_LIST,
  Methods.NATIVE_SESSION_WORKSPACE_READ,
  Methods.NATIVE_SESSION_WORKSPACE_CHANGES,
  Methods.NATIVE_SESSION_WORKSPACE_DIFF,
]);

/** A client guard prevents accidental bootstrap; the gateway remains the authority. */
export function workspaceAllowsMethod(
  access: WorkspaceAccess,
  method: string,
  params?: unknown,
): boolean {
  if (access === 'farm' || method === Methods.AUTH_CONNECT || method === Methods.GATEWAY_PING)
    return true;
  return (
    access === 'native' &&
    nativeMethods.has(method) &&
    !(params && typeof params === 'object' && 'worker' in params)
  );
}

export function workspaceHome(access: WorkspaceAccess) {
  return access === 'farm' ? '/(tabs)/runs' : access === 'native' ? '/native' : '/(tabs)/settings';
}

export function canOpenNativeConversation(access: WorkspaceAccess, runId?: string) {
  return access === 'farm' || (access === 'native' && !runId);
}
