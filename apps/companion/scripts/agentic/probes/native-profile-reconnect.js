const modules = Array.from(__r.getModules().values());
const store = modules.find((item) => item.verboseName?.endsWith('/store/connection.ts'))
  ?.publicModule.exports.useConnectionStore;
const router = modules.find((item) => item.verboseName?.endsWith('global-state/router-store.js'))
  ?.publicModule.exports.store;
const initial = store?.getState();
if (
  initial?.gatewayUrl !== 'ws://127.0.0.1:18777' ||
  initial.status !== 'connected' ||
  initial.principalId !== 'native-owner'
) {
  throw new Error('Expected the connected private gateway owner');
}
if (router?.getRouteInfo().pathname !== '/native' || router.getRouteInfo().params.sessionId) {
  throw new Error('Expected the native conversation creation form');
}
const client = initial.client;
const generation = client.connectionGeneration;
const transitions = [];
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error('Profile reconnect timeout'));
  }, 20000);
  const unsubscribe = store.subscribe((current) => {
    transitions.push({ status: current.status, generation: current.client?.connectionGeneration });
    if (
      current.status === 'connected' &&
      current.client?.connectionGeneration > generation &&
      transitions.some((t) => t.status === 'disconnected')
    ) {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
  // Drop only the actual private device transport; the app handles all state transitions.
  client.ws.close(4000, 'private profile selection reconnect proof');
});
return { transitions };
