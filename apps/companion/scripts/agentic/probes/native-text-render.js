// Read only the Companion recorder's native text render histogram: delta receipt → foreground paint.
const modules = Array.from(__r.getModules().values());
const store = modules.find((m) => m.verboseName?.endsWith('/store/connection.ts'))?.publicModule
  .exports.useConnectionStore;
const client = store?.getState().client;
if (!client) throw new Error('No connected gateway client');
return client.performance
  .snapshot()
  .histograms.filter((row) => row.name === 'farmslot_native_text_render_seconds');
