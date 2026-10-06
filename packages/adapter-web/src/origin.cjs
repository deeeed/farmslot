'use strict';

// Exact app-origin checks. A prefix match would let http://localhost:30001
// pass for http://localhost:3000, so every check parses the URL and compares
// origins.

/** @param {unknown} url @returns {string | null} */
function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

/** @param {unknown} url @param {string} appOrigin */
function isAppUrl(url, appOrigin) {
  const origin = originOf(url);
  return origin !== null && origin !== 'null' && origin === originOf(appOrigin);
}

// A CDP execution context belongs to the app only when it is the default
// context of the tab's top frame, on the app origin, while that frame's
// committed document is an app URL. The committed URL matters because an
// about:blank document (a popup the app opened) inherits the app origin. For
// a page target the main frame id equals the target id.
/**
 * @param {{ origin?: string, auxData?: { isDefault?: boolean, frameId?: string } } | null | undefined} context
 * @param {{ targetId: string | undefined, appOrigin: string, committedUrl: string | null }} scope
 */
function isAppTopFrameContext(context, { targetId, appOrigin, committedUrl }) {
  if (!context || !targetId) return false;
  const aux = context.auxData ?? {};
  return (
    aux.isDefault === true &&
    aux.frameId === targetId &&
    isAppUrl(context.origin, appOrigin) &&
    isAppUrl(committedUrl, appOrigin)
  );
}

// Where a request or document went, without its query string or fragment.
/** @param {unknown} url @returns {string} */
function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return String(url).slice(0, 120);
  }
}

module.exports = { isAppTopFrameContext, isAppUrl, originOf, shortUrl };
