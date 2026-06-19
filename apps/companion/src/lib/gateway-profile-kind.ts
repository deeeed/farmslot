export type GatewayProfileKind = 'lan' | 'custom' | 'remote' | 'tailnet';

export function inferGatewayProfileKindFromUrl(url: string): GatewayProfileKind {
  if (url.includes('.ts.net') || url.includes('.tailnet-')) return 'tailnet';
  if (url.startsWith('wss://')) return 'remote';
  return 'lan';
}

export function requiresSecureRemoteUrl(
  profile: Pick<{ kind: GatewayProfileKind; url: string }, 'kind' | 'url'>,
): boolean {
  return profile.kind === 'remote' && !profile.url.startsWith('wss://');
}
