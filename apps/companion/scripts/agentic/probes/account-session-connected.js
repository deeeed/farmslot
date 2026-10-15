const modules = Array.from(__r.getModules().values());
const connection = modules
  .find((m) => m.verboseName?.endsWith('/store/connection.ts'))
  ?.publicModule.exports.useConnectionStore.getState();
if (
  !connection ||
  connection.signedOut ||
  connection.status !== 'connected' ||
  !connection.principalId ||
  connection.workspaceAccess !== 'farm'
) {
  throw new Error('Explicit login did not restore account authority');
}
await connection.client.request('fleet.status');
return { connected: true, principalId: connection.principalId, fleetRpc: true };
