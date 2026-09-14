const view = document.querySelector('dispatch-wizard');
const root = view?.shadowRoot;
const worker = root?.querySelector('dispatch-native-profiles')?.shadowRoot;
const profile = worker?.querySelector('native-profiles')?.shadowRoot;
return {
  page: performance.timeOrigin,
  ticket: root?.querySelector('.ticket-input')?.value,
  transport: root?.querySelector('[data-testid=dispatch-transport]')?.value,
  node: worker?.querySelector('[data-testid=dispatch-native-node]')?.value,
  nodeDisabled: worker?.querySelector('[data-testid=dispatch-native-node]')?.disabled,
  profileMounted: Boolean(profile),
  selectedProfile: profile?.querySelector('[data-testid=native-profile]')?.value,
  profiles: [...(profile?.querySelector('[data-testid=native-profile]')?.options ?? [])].map(
    (option) => ({ id: option.value, label: option.textContent.trim() }),
  ),
  profileStatus: profile?.querySelector('[data-testid=native-profile-status]')?.textContent.trim(),
  dispatchDisabled: root?.querySelector('[data-testid=dispatch-submit]')?.disabled,
  dispatchReason: root?.querySelector('[data-testid=dispatch-submit]')?.title,
  queueDisabled: root?.querySelector('[data-testid=dispatch-queue]')?.disabled,
  queueReason: root?.querySelector('[data-testid=dispatch-queue]')?.title,
  runner: view?._runner,
  model: view?._model,
  slotId: view?._slotOverride,
  catalogReady: view?._nativeCatalogReady,
  selection: view?._nativeProfileSelection,
  allowedSlots: view?._blockingState().allowedSlots,
  errors: [
    ...(root?.querySelectorAll('.error, .error-inline') ?? []),
    ...(profile?.querySelectorAll('[role=alert]') ?? []),
    ...(worker?.querySelectorAll('[role=alert]') ?? []),
  ].map((element) => element.textContent.trim()),
};
