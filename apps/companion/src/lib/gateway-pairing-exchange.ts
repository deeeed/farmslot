import {
  type Frame,
  type GatewayAuthConnectResult,
  type GatewayPairingQrPayload,
  Methods,
  type PairingExchangeResult,
  parsePersonSessionGrant,
  type PersonSessionAuth,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import { isGatewayAuthConnectResult } from './gateway-connection-test';
import { pairingWebSocketConnectionError } from './gateway-pairing-errors';
import { profileFromPairingExchange } from './gateway-pairing-normalization';
import { sortPairingExchangeUrls } from './gateway-pairing-urls';

export type { GatewayPairingQrPayload, GatewayPairingQrProfile } from '@farmslot/protocol';

export type PairedGatewayProfile =
  | (PairingExchangeResult['profile'] & {
      personSession?: never;
      verification?: GatewayAuthConnectResult;
    })
  | {
      name: string;
      url: string;
      authMode: 'token';
      secret?: never;
      personSession: PersonSessionAuth;
      verification?: GatewayAuthConnectResult;
    };
export interface GatewayPairingExchange {
  profile: PairedGatewayProfile;
  expiresAt?: string;
}

const PAIRING_CONNECT_TIMEOUT_MS = 10_000;
const PAIRING_EXCHANGE_TIMEOUT_MS = 30_000;
type PairingExchange = (urls: string[], code: string) => Promise<GatewayPairingExchange>;

export async function exchangeGatewayPairingQr(
  payload: GatewayPairingQrPayload,
  exchange: PairingExchange = sendUnauthenticatedPairingExchangeWithFallback,
): Promise<PairedGatewayProfile[]> {
  const exchangeUrls = sortPairingExchangeUrls(
    uniqueUrls(payload.profiles.map((profile) => profile.url)),
  );
  const primaryProfile = payload.profiles[0];
  if (!primaryProfile) throw new Error('Pairing QR does not contain any profiles');
  if (payload.profiles.some((profile) => profile.code !== primaryProfile.code)) {
    throw new Error('Pairing QR contains multiple device codes');
  }
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
): Promise<GatewayPairingExchange> {
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      return await sendUnauthenticatedPairingExchange(url, code);
    } catch (error) {
      // The code is single-use. Once a gateway received it, another URL can only report it spent.
      if ((error as { codeSent?: boolean }).codeSent) throw error;
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
): Promise<GatewayPairingExchange> {
  return new Promise<GatewayPairingExchange>((resolve, reject) => {
    const ws = new WebSocket(url);
    let requestId = 'pairing-exchange';
    let candidate: PairedGatewayProfile | undefined;
    let invitationExpiry: string | undefined;
    let settled = false;
    let codeSent = false;
    const interrupted = () =>
      new Error(`Pairing on ${url} did not finish. Create a new pairing code and try again.`);
    let timer = setTimeout(() => {
      settleWithError(pairingWebSocketConnectionError(url));
    }, PAIRING_CONNECT_TIMEOUT_MS);

    const settleWithResult = (result: GatewayPairingExchange) => {
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
      reject(Object.assign(error, { codeSent }));
    };

    ws.onopen = () => {
      // An open queued behind the connect timeout must not send the code after fallback began.
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => settleWithError(interrupted()), PAIRING_EXCHANGE_TIMEOUT_MS);
      const frame: RequestFrame = {
        type: 'req',
        id: requestId,
        method: Methods.PAIRING_EXCHANGE,
        params: { code },
      };
      codeSent = true;
      ws.send(JSON.stringify(frame));
    };

    ws.onerror = () => {
      settleWithError(codeSent ? interrupted() : pairingWebSocketConnectionError(url));
    };

    ws.onclose = () => {
      if (!settled) {
        settleWithError(
          codeSent
            ? interrupted()
            : new Error('Pairing WebSocket closed before exchange completed'),
        );
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        settleWithError(new Error('Gateway returned a malformed pairing response.'));
        return;
      }

      if (frame.type !== 'res' || frame.id !== requestId) return;
      const response = frame as ResponseFrame;
      if (!response.ok) {
        if (
          requestId === 'pairing-exchange' &&
          response.error?.code === 'AUTH_PERSON_SESSION_REQUIRED'
        ) {
          requestId = 'person-session-exchange';
          const frame: RequestFrame = {
            type: 'req',
            id: requestId,
            method: Methods.AUTH_SESSION_EXCHANGE,
            params: { code, deviceName: 'Mobile Companion', deviceKind: 'companion' },
          };
          ws.send(JSON.stringify(frame));
        } else
          settleWithError(
            Object.assign(new Error(response.error?.message ?? 'Pairing exchange failed'), {
              code: response.error?.code,
            }),
          );
        return;
      }
      if (requestId === 'pairing-verification') {
        if (
          !candidate ||
          !isGatewayAuthConnectResult(response.payload) ||
          !response.payload.principal
        ) {
          settleWithError(new Error('Update the gateway before saving this pairing credential.'));
          return;
        }
        const verified = response.payload;
        if (
          candidate.personSession
            ? verified.principal?.subjectKind !== 'person' ||
              verified.principal.id !== candidate.personSession.session.principalId
            : verified.principal?.subjectKind === 'person'
        ) {
          settleWithError(new Error('Pairing did not produce a supported device sign-in.'));
          return;
        }
        settleWithResult({
          profile: { ...candidate, verification: verified },
          expiresAt: invitationExpiry,
        });
        return;
      }
      let verifyToken: string;
      if (requestId === 'person-session-exchange') {
        const grant = parsePersonSessionGrant(response.payload);
        if (!grant) {
          settleWithError(new Error('Gateway returned an invalid person session.'));
          return;
        }
        candidate = {
          name: 'Paired Gateway',
          url,
          authMode: 'token',
          personSession: { session: grant.session, refreshToken: grant.refreshToken },
        };
        verifyToken = grant.accessToken;
      } else {
        const exchanged = response.payload as PairingExchangeResult;
        candidate = exchanged.profile;
        invitationExpiry = exchanged.expiresAt;
        verifyToken = exchanged.profile.secret;
      }
      requestId = 'pairing-verification';
      const verify: RequestFrame = {
        type: 'req',
        id: requestId,
        method: Methods.AUTH_CONNECT,
        params: { clientKind: 'companion', token: verifyToken },
      };
      ws.send(JSON.stringify(verify));
    };
  });
}
