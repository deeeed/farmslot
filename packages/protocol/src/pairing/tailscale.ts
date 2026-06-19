export function parseTailscaleDnsNameFromStatus(stdout: string): string | null {
  let status: { Self?: { DNSName?: string } };
  try {
    status = JSON.parse(stdout);
  } catch {
    // Tailscale present but unparseable status = treat as absent; pairing can
    // still proceed over LAN/manual URLs.
    return null;
  }
  const dns = status.Self?.DNSName?.replace(/\.$/, '');
  return dns && dns.length > 0 ? dns : null;
}

export function isTailnetGatewayUrl(url: string): boolean {
  try {
    return isTailscaleMagicDnsHostname(new URL(url).hostname);
  } catch {
    // User-entered or QR-provided invalid URLs are not tailnet URLs; callers
    // validate/report URL shape separately.
    return false;
  }
}

export function isTailscaleMagicDnsHostname(hostname: string): boolean {
  return hostname.toLowerCase().endsWith('.ts.net');
}
