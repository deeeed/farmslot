import {
  receiveSharedViewLink,
  type SharedViewDeployment,
  type SharedViewReceipt,
} from '@farmslot/protocol/surfaces/view-links';

import {
  filterConnectableGatewayUrls,
  GATEWAY_CANDIDATES_STORAGE_KEY,
  GATEWAY_URL_STORAGE_KEY,
  resolveGatewayWebSocketUrls,
} from '../gateway-url.js';

interface SharedViewEnvironment extends ImportMeta {
  env?: {
    VITE_FARMSLOT_GATEWAY_URL?: string;
    VITE_FARMSLOT_COMMAND_CENTER_URL?: string;
    VITE_FARMSLOT_SHARED_GATEWAY_URLS?: string;
  };
}

export function sharedViewStartupReceipt(
  url: string,
  candidates: readonly string[],
  deployment: SharedViewDeployment,
): SharedViewReceipt {
  let result: SharedViewReceipt = { status: 'ordinary' };
  // Every fallback candidate must belong to the explicitly bound gateway.
  for (const candidate of candidates.length ? candidates : ['']) {
    result = receiveSharedViewLink(url, candidate, deployment);
    if (result.status === 'refused') return result;
  }
  return result;
}

function gatewayAliases(value: string | undefined): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return []; // A malformed binding refuses shared links; ordinary navigation is unchanged.
  }
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
}

/** Runs before importing gateway consumers or mounting a requested view. */
export function browserSharedViewReceipt(): SharedViewReceipt {
  const env = (import.meta as SharedViewEnvironment).env ?? {};
  const candidates = resolveGatewayWebSocketUrls(
    env.VITE_FARMSLOT_GATEWAY_URL,
    location,
    localStorage.getItem(GATEWAY_CANDIDATES_STORAGE_KEY),
    localStorage.getItem(GATEWAY_URL_STORAGE_KEY),
  );
  const { connectable } = filterConnectableGatewayUrls(candidates, location);
  return sharedViewStartupReceipt(location.href, connectable, {
    commandCenterUrl: env.VITE_FARMSLOT_COMMAND_CENTER_URL,
    gatewayUrls: gatewayAliases(env.VITE_FARMSLOT_SHARED_GATEWAY_URLS),
  });
}
