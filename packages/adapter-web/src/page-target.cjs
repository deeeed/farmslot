'use strict';

const { asBrowserCdpTarget } = require('./browser-cdp.cjs');

// Choose the page a recipe drives from a CDP target list: a page on `origin`,
// preferring one whose URL carries `hash`. Returns null when no page matches;
// the caller owns the error it reports.
function selectPageTarget(targets, { origin, hash = '' }) {
  const pages = targets.filter((target) => {
    if (target.type !== 'page' || !target.url) return false;
    try {
      return new URL(target.url).origin === origin;
    } catch {
      // Browser-internal targets without a parseable URL cannot host the app.
      return false;
    }
  });
  if (pages.length === 0) return null;
  if (hash) {
    const needle = hash.startsWith('#') ? hash : `#${hash}`;
    const matched = pages.find((target) => target.url.includes(needle));
    if (matched) return matched;
  }
  return pages[0];
}

// Choose an extension's UI renderer from a CDP target list (`Target.getTargets`
// or `/json`): a page or `other` target of `extensionId` whose path is one of
// `paths`, tried in order. The first path with any match decides: exactly one
// match is returned, several are ambiguous and return null.
/**
 * @param {unknown} targets
 * @param {string} extensionId
 * @param {{ paths: readonly string[] }} options
 * @returns {{ targetId: string, type: string, url: string } | null}
 */
function selectExtensionTarget(targets, extensionId, { paths }) {
  const candidates = [];
  for (const value of Array.isArray(targets) ? targets : []) {
    const target = asBrowserCdpTarget(value);
    if (!target || !['page', 'other'].includes(target.type)) continue;
    try {
      const url = new URL(target.url);
      if (url.protocol === 'chrome-extension:' && url.hostname === extensionId) {
        candidates.push({ target, pathname: url.pathname });
      }
    } catch {
      // Not a URL: not an extension target.
    }
  }
  for (const pathname of paths) {
    const matches = candidates.filter((candidate) => candidate.pathname === pathname);
    if (matches.length > 0) return matches.length === 1 ? matches[0].target : null;
  }
  return null;
}

module.exports = { selectExtensionTarget, selectPageTarget };
