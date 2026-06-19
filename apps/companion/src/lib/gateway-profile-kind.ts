export type GatewayProfileKind = 'lan' | 'custom' | 'remote' | 'tailnet';

export function inferGatewayProfileKindFromUrl(url: string): GatewayProfileKind {
  if (isTailnetGatewayUrl(url)) return 'tailnet';
  if (url.startsWith('wss://')) return 'remote';
  return 'lan';
}

export function isTailnetGatewayUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname.endsWith('.ts.net') || hostname.includes('.tailnet-');
  } catch {
    return false;
  }
}

export function requiresSecureRemoteUrl(profile: {
  kind: GatewayProfileKind;
  url: string;
}): boolean {
  return profile.kind === 'remote' && !profile.url.startsWith('wss://');
}
