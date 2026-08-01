// Keep in sync with services/gateway/src/runners/registry.ts paneShowsBusyComposer.
export function paneShowsBusyComposer(pane) {
  const liveTail = pane.split('\n').slice(-20).join('\n');
  return (
    /tab to queue message/i.test(liveTail) ||
    /Working \(/i.test(liveTail) ||
    /background terminal running/i.test(liveTail) ||
    /(?:^|\n)\s*(?:[·*•]|[✻✢✽✶✷✸✹✺✼✣∗])\s*Composing[…\.](?:\s+\([^)]*(?:\d+\s*[smh]|esc to interrupt)[^)]*\))?\s*(?:\n|$)/iu.test(
      liveTail,
    )
  );
}

export function paneShowsBypassPermissions(pane) {
  return /bypass permissions on/i.test(pane);
}
