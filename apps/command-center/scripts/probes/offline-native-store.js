const view = document.querySelector('native-session-view');
if (!view) return { mounted: false };
await view.updateComplete;
const root = view.shadowRoot;
const state = view.historyObservation;
const page = state?.data;
const messages = (page?.events ?? []).filter((event) =>
  ['command.submitted', 'command.accepted', 'text.delta'].includes(event.type),
);
const notice = document.querySelector('farm-resource-store-notice');
const stored = await notice.resourceStoreQueryMetadata();
const resume = root.querySelector('[data-testid="native-resume"]');
const resumeRect = resume?.getBoundingClientRect();
const resumeVisible = Boolean(
  resumeRect &&
  resumeRect.top >= 0 &&
  resumeRect.left >= 0 &&
  resumeRect.bottom <= innerHeight &&
  resumeRect.right <= innerWidth,
);
const saved = root.querySelector('[data-testid="native-history-saved"]');
return {
  mounted: true,
  selectedId: view.selectedId,
  inventoryIds: view.sessions.map((session) => session.id),
  sessionChoices: [...root.querySelectorAll('[data-testid="native-session-select"] option')].map(
    (option) => option.value,
  ),
  sessionId: page?.session.id,
  status: state?.status,
  observedAt: state?.observedAt,
  cursor: page?.cursor,
  canonical: view.session === page?.session && view.transcript.events === page?.events,
  logicalMessages: messages.length,
  firstMessage: messages[0]?.text,
  lastMessage: messages.at(-1)?.text,
  renderedMessages: root.querySelectorAll('.timeline article.user, .timeline article.assistant')
    .length,
  savedText: saved?.textContent.replace(/\s+/g, ' ').trim(),
  savedObservedAt: saved ? Number(saved.dataset.observedAt) : undefined,
  resumeVisible,
  resumeDisabled: root.querySelector('[data-testid="native-resume"]')?.disabled,
  inputDisabled: root.querySelector('[data-testid="native-message"]')?.disabled,
  localCommand: Boolean(view.localCommand),
  storedHistoryIds: stored
    .map(({ id }) => id)
    .filter((id) => id.startsWith('native.session.read:')),
  storage: (await notice.resourceStoreDiagnostics())?.storage,
  errors: [...root.querySelectorAll('[role="alert"]')].map((row) => row.textContent.trim()),
};
