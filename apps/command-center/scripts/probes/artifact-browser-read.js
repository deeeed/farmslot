// Observe the real mounted browser; never replaces artifacts or view state.
const detail = document.querySelector('run-detail');
const panel = detail?.shadowRoot?.querySelector('[data-testid="run-artifact-explorer"]');
const browser = panel
  ?.querySelector('step-artifacts')
  ?.shadowRoot?.querySelector('artifact-browser');
const root = browser?.shadowRoot;
const viewer = root?.querySelector('media-lightbox');
const image = viewer?.shadowRoot?.querySelector('img.ml-expanded');
return {
  connected: document.querySelector('farm-app')?.connection === 'connected',
  modalOpen: Boolean(
    document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button.primary'),
  ),
  browserWidth: browser?.getBoundingClientRect().width ?? 0,
  runId: detail?.runId,
  url: location.href,
  panelOpen:
    detail?.shadowRoot
      ?.querySelector('[data-testid="run-artifacts-toggle"]')
      ?.getAttribute('aria-expanded') === 'true',
  paths: browser?.artifacts.map((file) => file.path) ?? [],
  query: browser?.viewState?.query ?? '',
  types: [...(browser?.viewState?.types ?? [])],
  chips: [...(root?.querySelectorAll('.chips .chip') ?? [])].map((chip) => ({
    text: chip.textContent.trim(),
    pressed: chip.getAttribute('aria-pressed') === 'true',
  })),
  folders: [...(root?.querySelectorAll('[role="treeitem"][aria-expanded]') ?? [])].map((row) => ({
    key: row.dataset.key,
    expanded: row.getAttribute('aria-expanded') === 'true',
  })),
  files: [...(root?.querySelectorAll('a.file') ?? [])].map((file) => file.title),
  match: root?.querySelector('.match-count')?.textContent.trim() ?? null,
  preview: {
    path: viewer?.items?.[viewer.selectedIndex]?.path ?? null,
    markdownChars:
      viewer?.shadowRoot?.querySelector('.ml-md-content')?.textContent.trim().length ?? 0,
    imageWidth: image?.naturalWidth ?? 0,
    imageHeight: image?.naturalHeight ?? 0,
    error: viewer?.shadowRoot?.querySelector('.ml-broken')?.textContent.trim() ?? null,
  },
};
