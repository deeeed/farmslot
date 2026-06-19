import {
  type Frame,
  Methods,
  type PairingExchangeResult,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import { inferGatewayProfileKindFromUrl } from './gateway-profile-kind';
import { profileFromPairingExchange } from './gateway-pairing-normalization';
import {
  type GatewayProfile,
  isMobileGatewayProfileUrl,
  profileSecretStorageKey,
} from './gateway-profiles';

export interface GatewayPairingQrPayload {
  type: 'farmslot.gateway-pairing.v1';
  profiles: GatewayPairingQrProfile[];
}

export interface GatewayPairingQrProfile {
  url: string;
  code: string;
  profileName?: string;
  expiresAt?: string;
}

const PAIRING_TIMEOUT_MS = 15_000;

export function parseGatewayPairingQr(data: string): GatewayPairingQrPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(`Invalid pairing QR JSON: ${(error as Error).message}`);
  }

  const payload = parsed as Partial<GatewayPairingQrPayload & GatewayPairingQrProfile>;
  if (payload.type !== 'farmslot.gateway-pairing.v1') {
    throw new Error('QR code is not a Farmslot pairing payload');
  }

  const rawProfiles = Array.isArray(payload.profiles)
    ? payload.profiles
    : [
        {
          url: payload.url,
          code: payload.code,
          profileName: payload.profileName,
          expiresAt: payload.expiresAt,
        },
      ];
  const profiles = rawProfiles.map((profile, index) => normalizePairingProfile(profile, index));
  if (profiles.length === 0) {
    throw new Error('Pairing QR does not contain any profiles');
  }

  return {
    type: 'farmslot.gateway-pairing.v1',
    profiles,
  };
}

export async function exchangeGatewayPairingQr(
  payload: GatewayPairingQrPayload,
): Promise<PairingExchangeResult['profile'][]> {
  const exchangeUrls = uniqueUrls(payload.profiles.map((profile) => profile.url));
  const results = await Promise.all(
    payload.profiles.map(async (profile) => {
      const result = await sendUnauthenticatedPairingExchangeWithFallback(
        exchangeUrls,
        profile.code,
      );
      return profileFromPairingExchange(profile, result);
    }),
  );
  return results;
}

export function profileFromPairingResult(
  profile: PairingExchangeResult['profile'],
  profileId = profileIdForPairedProfile(profile),
): GatewayProfile {
  const kind = inferGatewayProfileKindFromUrl(profile.url);
  return {
    id: profileId,
    name: profile.name,
    url: profile.url,
    kind,
    authMode: profile.authMode,
    secretStorageKey: profileSecretStorageKey(profileId),
  };
}

function normalizePairingProfile(profile: unknown, index: number): GatewayPairingQrProfile {
  const candidate = profile as Partial<GatewayPairingQrProfile>;
  if (typeof candidate.url !== 'string' || !isMobileGatewayProfileUrl(candidate.url)) {
    throw new Error(`Pairing QR profile ${index + 1} has an invalid gateway URL`);
  }
  if (typeof candidate.code !== 'string' || candidate.code.trim().length === 0) {
    throw new Error(`Pairing QR profile ${index + 1} is missing its exchange code`);
  }
  return {
    url: candidate.url,
    code: candidate.code,
    ...(typeof candidate.profileName === 'string' ? { profileName: candidate.profileName } : {}),
    ...(typeof candidate.expiresAt === 'string' ? { expiresAt: candidate.expiresAt } : {}),
  };
}

function profileIdForPairedProfile(profile: PairingExchangeResult['profile']): string {
  try {
    const parsed = new URL(profile.url);
    const protocol = parsed.protocol.replace(':', '');
    return `paired-${slugForProfileId(`${protocol}-${parsed.host}${parsed.pathname}`)}`;
  } catch {
    return `paired-${slugForProfileId(`${profile.name}-${profile.url}`)}`;
  }
}

function slugForProfileId(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  return slug || 'gateway';
}

async function sendUnauthenticatedPairingExchangeWithFallback(
  urls: string[],
  code: string,
): Promise<PairingExchangeResult> {
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      return await sendUnauthenticatedPairingExchange(url, code);
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error('Pairing exchange failed');
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls)];
}

function sendUnauthenticatedPairingExchange(
  url: string,
  code: string,
): Promise<PairingExchangeResult> {
  return new Promise<PairingExchangeResult>((resolve, reject) => {
    const ws = new WebSocket(url);
    const requestId = 'pairing-exchange';
    let settled = false;
    const timer = setTimeout(() => {
      settleWithError(new Error('Pairing exchange timed out'));
    }, PAIRING_TIMEOUT_MS);

    const settleWithResult = (result: PairingExchangeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };

    const settleWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(error);
    };

    ws.onopen = () => {
      const frame: RequestFrame = {
        type: 'req',
        id: requestId,
        method: Methods.PAIRING_EXCHANGE,
        params: { code },
      };
      ws.send(JSON.stringify(frame));
    };

    ws.onerror = () => {
      settleWithError(new Error('Pairing WebSocket connection failed'));
    };

    ws.onclose = () => {
      if (!settled)
        settleWithError(new Error('Pairing WebSocket closed before exchange completed'));
    };

    ws.onmessage = (event: MessageEvent) => {
      let frame: Frame;
      try {
        frame = JSON.parse(event.data as string);
      } catch (error) {
        settleWithError(
          new Error(`Gateway returned malformed pairing response: ${(error as Error).message}`),
        );
        return;
      }

      if (frame.type !== 'res' || frame.id !== requestId) return;
      const response = frame as ResponseFrame;
      if (!response.ok) {
        settleWithError(new Error(response.error?.message ?? 'Pairing exchange failed'));
        return;
      }
      settleWithResult(response.payload as PairingExchangeResult);
    };
  });
}
