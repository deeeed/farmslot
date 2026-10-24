// Read the actual configuration controllers and rendered controls without changing state.
const panel = document.querySelector('config-panel');
if (!panel) return { mounted: false };
const loaded = (suffix) =>
  performance
    .getEntriesByType('resource')
    .map(({ name }) => name)
    .filter((name) => new URL(name).pathname.endsWith(suffix))
    .at(-1);
const ownerUrl = loaded('/src/resource-cache.ts');
const gatewayUrl = loaded('/src/gateway-client.ts');
if (!ownerUrl || !gatewayUrl) return { mounted: true, loaded: false };
const { getResourceCache } = await import(ownerUrl);
const { gateway } = await import(gatewayUrl);
const cache = getResourceCache();
const observations = {};
function read(controller) {
  const query = controller && Reflect.get(controller, 'query');
  if (!query) return;
  if (controller.belongsToWorkspace && cache.read(query) !== controller.state)
    throw Error('Use actual canonical configuration state');
  observations[query.method] = {
    id: query.id,
    params: query.params,
    ready: controller.ready,
    ...controller.state,
  };
}
for (const name of ['_poolsQuery', '_poolRawQuery', '_projectsQuery'])
  read(Reflect.get(panel, name));
const templates = panel.querySelector('template-viewer');
if (templates) read(Reflect.get(templates, '_query'));
const llm = panel.querySelector('llm-config');
if (llm) for (const name of ['_configQuery', '_authQuery']) read(Reflect.get(llm, name));
const editor = panel.querySelector('.cp-json-editor');
return {
  mounted: true,
  connection: gateway.connectionState,
  connectionId: gateway.resourceConnectionId,
  observations,
  poolSlots: [...panel.querySelectorAll('slot-toggle')].map((toggle) => ({
    slotId: toggle.slotId,
    enabled: toggle.enabled,
    title: toggle.shadowRoot?.querySelector('button')?.title,
  })),
  editor: editor && {
    value: editor.value,
    dirty: Reflect.get(panel, '_editorDirty'),
    error: Reflect.get(panel, '_editorError'),
  },
  templates: templates && {
    text: templates.shadowRoot?.textContent,
    raw: templates.shadowRoot?.querySelector('.raw-content pre')?.textContent,
  },
  providers: llm && { text: llm.shadowRoot?.textContent, cards: Reflect.get(llm, '_providers') },
};
