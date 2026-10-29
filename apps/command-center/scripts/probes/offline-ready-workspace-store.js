const view = document.querySelector('run-detail')?.shadowRoot?.querySelector('ready-workspace');
if (!view) throw new Error('Open the actual gate workspace');
const query = Reflect.get(view._queries.run, 'query');
if (!query) throw new Error('Observe the actual full run');
const { inspectResourceAuthority } = await import('/src/dev/resource-authority-proof.ts');
return inspectResourceAuthority(undefined, query);
