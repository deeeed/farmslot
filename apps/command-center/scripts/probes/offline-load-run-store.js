const slot = document.querySelector('slot-view');
const modal = slot?.renderRoot?.querySelector('slot-load-run-modal');
const controller = modal && Reflect.get(modal, 'runsQuery');
const query = controller && Reflect.get(controller, 'query');
if (!query) throw new Error('Open the actual load dialog before reading its saved query');
const { inspectResourceAuthority } = await import('/src/dev/resource-authority-proof.ts');
return inspectResourceAuthority(undefined, query);
