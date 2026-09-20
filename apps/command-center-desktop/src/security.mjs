export function isAppPage(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && ['/cc/', '/settings'].includes(url.pathname);
  } catch {
    // Invalid URLs cannot identify a trusted app document.
    return false;
  }
}

export function assertTrustedSender(event, window, origin) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !isAppPage(event.senderFrame.url, origin)
  ) {
    throw new Error('Untrusted desktop request.');
  }
}

export function linkAction(value, origin, connection) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'deny'; // A malformed URL is never navigable.
  }
  if (isAppPage(value, origin)) return 'internal';
  if (url.protocol === 'blob:' && url.origin === origin) return 'download';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'deny';
  if (url.origin === origin) return 'deny';
  if (connection) {
    const gateway = new URL(connection.url);
    gateway.protocol = gateway.protocol === 'wss:' ? 'https:' : 'http:';
    if (url.origin === gateway.origin && url.pathname.startsWith('/api/')) return 'download';
  }
  return 'external';
}

export function allowsPermission(window, contents, permission, details, origin) {
  return Boolean(
    window &&
    !window.isDestroyed() &&
    contents === window.webContents &&
    details.isMainFrame &&
    isAppPage(details.requestingUrl, origin) &&
    [
      'clipboard-read',
      'clipboard-sanitized-write',
      'deprecated-sync-clipboard-read',
      'notifications',
    ].includes(permission),
  );
}
