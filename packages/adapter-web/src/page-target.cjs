'use strict';

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

module.exports = { selectPageTarget };
