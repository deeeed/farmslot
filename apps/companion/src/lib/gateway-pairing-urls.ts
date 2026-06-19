import { isTailnetGatewayUrl } from '@farmslot/protocol';

export function sortPairingExchangeUrls(urls: string[]): string[] {
  return [...urls].sort((a, b) => pairingExchangeUrlRank(a) - pairingExchangeUrlRank(b));
}

function pairingExchangeUrlRank(url: string): number {
  if (isTailnetGatewayUrl(url)) return 0;
  if (url.startsWith('wss://')) return 1;
  return 2;
}
