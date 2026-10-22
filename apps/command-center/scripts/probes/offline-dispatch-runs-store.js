const view = document.querySelector('dispatch-wizard');
if (!view) throw new Error('Open the actual dispatch wizard before inspecting its query');
const controller = Reflect.get(view, '_comparePickerOpen')
  ? Reflect.get(view, 'comparisonQuery')
  : Reflect.get(view, 'baselineQuery');
const query = Reflect.get(controller, 'query');
if (!query) throw new Error('Observe the actual dispatch query before inspecting its saved row');
const { inspectResourceAuthority } = await import('/src/dev/resource-authority-proof.ts');
const result = await inspectResourceAuthority(undefined, query);
if (result.cacheStatus !== controller.state.status)
  throw new Error('Inspect the cache owning the rendered dispatch query');
return result;
