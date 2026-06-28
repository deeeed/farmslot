// CDP probe: comparison-lane dispatch wizard omits shared production branch.
(() => {
  const wizard = document.querySelector('dispatch-wizard');
  if (!wizard) return { ok: false, reason: 'dispatch-wizard not found' };
  const draft = wizard._dispatchPayloadDraft?.();
  if (!draft) return { ok: false, reason: '_dispatchPayloadDraft unavailable' };
  const banner = document.querySelector('.comparison-mode-banner');
  const bannerText = banner?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return {
    ok: draft.comparison?.lane === 'comparison' && draft.branch == null,
    draftBranch: draft.branch ?? null,
    lane: draft.comparison?.lane ?? null,
    variant: draft.comparison?.variant ?? null,
    bannerHasHint: /auto-derived/i.test(bannerText),
    bannerText: bannerText.slice(0, 200),
  };
})();
