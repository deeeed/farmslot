// Keep in sync with services/gateway/src/runners/registry.ts paneShowsBusyComposer.
export function paneShowsBusyComposer(pane) {
  return (
    /tab to queue message/i.test(pane) ||
    /Working \(/i.test(pane) ||
    /background terminal running/i.test(pane) ||
    /(?:^|\n)\s*(?:·|[✻✢✽✶✷✸✹✺✼✣∗])\s*Composing[…\.](?:\s+\([^)]*(?:\d+\s*[smh]|esc to interrupt)[^)]*\))?\s*(?:\n|$)/iu.test(
      pane,
    )
  );
}

export function paneShowsBypassPermissions(pane) {
  return /bypass permissions on/i.test(pane);
}
