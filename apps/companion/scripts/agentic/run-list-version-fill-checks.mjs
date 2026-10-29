// The receipt checks of prove-run-list-version-fill.mjs, kept apart so they are tested.

/** Version lists rule 4: pages of at most 2 MB, gateway-enforced; one larger row comes alone. */
export const PAGE_BYTES = 2 * 1024 * 1024;
export const FRAMING_BYTES = 64 * 1024;
/** Decision 7: each page within Companion's run list request timeout. */
export const PAGE_MS = 60_000;

/** Pages carry at most 2 MB, except a page that carries a single row over the cap. */
export function pageReport(frames) {
  const pages = frames.filter((frame) => frame.kind === 'ids');
  const oversized = pages.filter((page) => page.responseBytes > PAGE_BYTES + FRAMING_BYTES);
  return {
    versionReads: frames.filter((frame) => frame.kind === 'versions').length,
    listReads: frames.filter((frame) => frame.kind === 'list').length,
    pages: pages.length,
    maxPageMs: Math.max(0, ...pages.map((page) => page.requestMs)),
    maxPageBytes: Math.max(0, ...pages.map((page) => page.responseBytes)),
    oversizedPage: oversized.length > 0 && oversized.every((page) => page.rows === 1),
    pagesWithinBounds:
      pages.every((page) => page.ok && page.requestMs < PAGE_MS) &&
      oversized.every((page) => page.rows === 1),
    requestedIds: [...new Set(pages.flatMap((page) => page.requestedIds ?? []))],
  };
}

/** The ids read after a change are exactly the changed runs; no full reread. */
export function catchUpHolds(report, changed, count) {
  const read = new Set(report.requestedIds);
  const exact = changed
    ? read.size === changed.length && changed.every((id) => read.has(id))
    : read.size === count;
  return report.versionReads >= 1 && report.listReads === 0 && report.pagesWithinBounds && exact;
}

/**
 * Offline after a cold start: the whole stored history and its total, and no request sent. A
 * request that never got a reply still counts, so this reads the app's sent-frame count.
 */
export function offlineTotalsHold(state, { expected, minRuns }) {
  return (
    state.framesSent === 0 &&
    state.history.rows === state.history.totalCount &&
    (expected === undefined
      ? state.history.totalCount >= minRuns
      : state.history.totalCount === expected)
  );
}
