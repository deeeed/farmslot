/** Hosts the dev server may serve and the dev gateway may admit. Drops wildcards and host:port. */
export function explicitDevHosts(csv: string | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(
      (host) =>
        /^[a-z0-9.-]+$/i.test(host) &&
        !host.startsWith('.') &&
        !host.endsWith('.') &&
        !host.includes('..'),
    )
    .map((host) => host.toLowerCase());
}
