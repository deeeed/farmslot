import { uiUrl } from './ui-source.mjs';

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https:; img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function isUiPage(value, origin, developmentUrl = null) {
  try {
    const url = new URL(value);
    const target = new URL(uiUrl(origin, developmentUrl));
    return (
      !url.username &&
      !url.password &&
      url.origin === target.origin &&
      url.pathname === target.pathname
    );
  } catch {
    // Invalid URLs cannot identify a trusted app document.
    return false;
  }
}

export function isAppPage(value, origin, developmentUrl = null) {
  try {
    const url = new URL(value);
    return (
      (!url.username && !url.password && url.origin === origin && url.pathname === '/settings') ||
      isUiPage(value, origin, developmentUrl)
    );
  } catch {
    return false; // Invalid URLs are not trusted settings or UI documents.
  }
}

export function assertTrustedSender(event, window, origin, developmentUrl = null) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !isAppPage(event.senderFrame.url, origin, developmentUrl)
  ) {
    throw new Error('Untrusted desktop request.');
  }
}

export function linkAction(value, origin, connection, developmentUrl = null) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'deny'; // A malformed URL is never navigable.
  }
  if (isAppPage(value, origin, developmentUrl)) return 'internal';
  if (url.protocol === 'blob:' && url.origin === new URL(uiUrl(origin, developmentUrl)).origin)
    return 'download';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'deny';
  if (url.origin === origin) return 'deny';
  if (connection) {
    const gateway = new URL(connection.url);
    gateway.protocol = gateway.protocol === 'wss:' ? 'https:' : 'http:';
    if (url.origin === gateway.origin && url.pathname.startsWith('/api/')) return 'download';
  }
  return 'external';
}

export function allowsPermission(
  window,
  contents,
  permission,
  details,
  origin,
  developmentUrl = null,
) {
  return Boolean(
    window &&
    !window.isDestroyed() &&
    contents === window.webContents &&
    details.isMainFrame &&
    isAppPage(details.requestingUrl, origin, developmentUrl) &&
    [
      'clipboard-read',
      'clipboard-sanitized-write',
      'deprecated-sync-clipboard-read',
      'notifications',
    ].includes(permission),
  );
}
