// Testnet enforcement mechanics for the web-dapp slot browser: the hosts a
// venue policy blocks become unresolvable for the whole browser (pages,
// workers, WebSockets), and the wallet host fails and logs each request it
// sees to one of them. Which hosts is the venue policy's (venueHosts).

// A URL's host as the network sees it: lowercase, no trailing dot. null when
// it does not parse.
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    return null;
  }
}

export function isBlockedUrl(url, hosts) {
  const host = hostOf(url);
  return host !== null && hosts.includes(host);
}

export function hostResolverRules(hosts) {
  // The host and its fully qualified form (trailing dot) alike.
  return `--host-resolver-rules=${hosts.flatMap((host) => [`MAP ${host} ~NOTFOUND`, `MAP ${host}. ~NOTFOUND`]).join(', ')}`;
}
