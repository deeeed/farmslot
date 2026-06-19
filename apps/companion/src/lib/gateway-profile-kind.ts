import { isTailnetGatewayUrl } from '@farmslot/protocol';

export type GatewayProfileKind = 'lan' | 'custom' | 'remote' | 'tailnet';

export function inferGatewayProfileKindFromUrl(url: string): GatewayProfileKind {
  if (isTailnetGatewayUrl(url)) return 'tailnet';
  if (url.startsWith('wss://')) return 'remote';
  return 'lan';
}

export function requiresSecureRemoteUrl(profile: {
  kind: GatewayProfileKind;
  url: string;
}): boolean {
  return profile.kind === 'remote' && !profile.url.startsWith('wss://');
}
