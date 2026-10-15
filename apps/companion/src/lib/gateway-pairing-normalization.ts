import type { GatewayPairingExchange, PairedGatewayProfile } from './gateway-pairing-exchange';

export interface GatewayPairingQrProfileForExchange {
  url: string;
  profileName?: string;
}

export function profileFromPairingExchange(
  qrProfile: GatewayPairingQrProfileForExchange,
  exchangeResult: GatewayPairingExchange,
): PairedGatewayProfile {
  return {
    ...exchangeResult.profile,
    name: exchangeResult.profile.name.trim() || qrProfile.profileName?.trim() || 'Farmslot Gateway',
    // The gateway may report a bind/self URL such as localhost. The QR profile URL
    // is the mobile-reachable address that was validated before exchange.
    url: qrProfile.url,
  };
}
