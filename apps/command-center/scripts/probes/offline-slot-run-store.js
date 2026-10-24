const view = document.querySelector('slot-view');
if (!view?._linkedRun) throw new Error('Open the actual slot run before inspecting its saved row');
const url = performance
  .getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => new URL(name).pathname.endsWith('/packages/protocol/src/client-cache/index.ts'))
  .at(-1);
if (!url) throw new Error('The shared cache module did not load');
const { resourceQuery } = await import(url);
const { inspectResourceAuthority } = await import('/src/dev/resource-authority-proof.ts');
const result = await inspectResourceAuthority(
  undefined,
  resourceQuery('run.get', { runId: view._linkedRun.id }),
);
if (result.cacheStatus !== view._runQueries.pinned.state.status)
  throw new Error('Inspect the cache owning the actual pinned run');
return result;
