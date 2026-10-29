const detail = document.querySelector('run-detail');
if (!detail) throw new Error('Open the actual run detail before inspecting its saved row');
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
  resourceQuery('run.get', { runId: detail.runId }),
);
if (result.cacheStatus !== Reflect.get(detail, '_runObservation')?.status)
  throw new Error('Inspect the cache module owning the rendered detail');
return result;
