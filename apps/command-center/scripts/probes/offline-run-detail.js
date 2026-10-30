const detail = document.querySelector('run-detail');
if (!detail?.shadowRoot) return { mounted: false };
const storage = (
  await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics()
)?.storage;
const observation = Reflect.get(detail, '_runObservation');
const query = Reflect.get(detail, 'detailQuery');
if (observation !== query?.state) throw new Error('Inspect the query owning the rendered detail');
const run = detail.run;
const root = detail.shadowRoot;
const editor = root.querySelector('run-tag-editor:not([kind="tickets"])');
const commands = [...root.querySelectorAll('button')].filter((button) =>
  /^(Delete run|Refresh output)$/.test(button.textContent.trim()),
);
const recipe = Reflect.get(detail, '_recipeObservation');
const tray = document.querySelector('farm-notification-tray')?.shadowRoot;
const noticesClosed = tray?.querySelector('.bell')?.getAttribute('aria-expanded') === 'false';
const readNotice = (id) =>
  [...(tray?.querySelectorAll('[data-notice-id]') ?? [])].find(
    (item) => item.getAttribute('data-notice-id') === `read:${id}`,
  );
const noticeText = (item) => item?.querySelector('p')?.textContent.trim();
return {
  mounted: true,
  noticesClosed,
  readNoticesNeeded: observation?.status === 'stale',
  runId: detail.runId,
  visibleRun: run?.id,
  storage,
  freshness: observation?.status,
  observedAt: observation?.observedAt,
  error: observation?.error,
  fullObservationRendered: Boolean(run && run === observation?.data?.run),
  titleRendered: Boolean(run && root.textContent.includes(run.ticketOrPr)),
  tags: run?.tags ?? [],
  renderedTags: [...(editor?.shadowRoot?.querySelectorAll('.tag-pill') ?? [])].map((tag) =>
    tag.textContent.trim().replace(/^#/, ''),
  ),
  artifactPaths: run?.output?.artifactManifest?.map((artifact) => artifact.path) ?? [],
  recipeFreshness: recipe?.status,
  recipeArtifactPaths: (Reflect.get(detail, '_recipeRuns') ?? []).flatMap((group) =>
    group.artifactManifest.map((artifact) => artifact.path),
  ),
  stale: noticeText(readNotice(Reflect.get(query, 'query')?.id)),
  actionsBlocked: Reflect.get(detail, '_actionsBlocked').call(detail),
  commandsDisabled: Boolean(
    editor?.disabled && commands.length && commands.every((button) => button.disabled),
  ),
  missingRendered: Boolean(
    root.querySelector('.empty')?.textContent.includes('Run is no longer available'),
  ),
};
