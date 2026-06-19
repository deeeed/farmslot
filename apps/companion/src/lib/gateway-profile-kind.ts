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

export function gatewayProfileKindUrlError(profile: {
  kind: GatewayProfileKind;
  url: string;
}): string | null {
  if (profile.kind === 'tailnet' && !isTailnetGatewayUrl(profile.url)) {
    return 'Tailnet profiles must use a Tailscale MagicDNS .ts.net URL.';
  }
  if (requiresSecureRemoteUrl(profile)) {
    return 'Remote profiles must use wss://. Tailnet profiles may use ws:// inside Tailscale.';
  }
  return null;
}
