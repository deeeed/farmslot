import {
  type Frame,
  Methods,
  type PairingExchangeResult,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import { pairingWebSocketConnectionError } from './gateway-pairing-errors';
import { profileFromPairingExchange } from './gateway-pairing-normalization';
import { sortPairingExchangeUrls } from './gateway-pairing-urls';

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
type PairingExchange = (urls: string[], code: string) => Promise<PairingExchangeResult>;

export async function exchangeGatewayPairingQr(
  payload: GatewayPairingQrPayload,
  exchange: PairingExchange = sendUnauthenticatedPairingExchangeWithFallback,
): Promise<PairingExchangeResult['profile'][]> {
  const exchangeUrls = sortPairingExchangeUrls(
    uniqueUrls(payload.profiles.map((profile) => profile.url)),
  );
  const primaryProfile = payload.profiles[0];
  if (!primaryProfile) throw new Error('Pairing QR does not contain any profiles');
  const result = await exchange(exchangeUrls, primaryProfile.code);
  return payload.profiles.map((profile) =>
    profileFromPairingExchange(profile, {
      ...result,
      profile: {
        ...result.profile,
        name: profile.profileName?.trim() || result.profile.name,
      },
    }),
  );
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
      settleWithError(pairingWebSocketConnectionError(url));
    };

    ws.onclose = () => {
      if (!settled) {
        settleWithError(new Error('Pairing WebSocket closed before exchange completed'));
      }
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
