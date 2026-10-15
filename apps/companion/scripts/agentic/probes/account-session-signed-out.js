const modules = Array.from(__r.getModules().values());
const connection = modules
  .find((m) => m.verboseName?.endsWith('/store/connection.ts'))
  ?.publicModule.exports.useConnectionStore.getState();
if (!connection) throw new Error('Companion connection store is unavailable');
if (
  !connection.signedOut ||
  connection.status === 'connected' ||
  connection.principalId ||
  connection.workspaceAccess !== 'none' ||
  Object.keys(connection.activeProfileHttpAuthHeaders).length
) {
  throw new Error('Sign-out retained account authority');
}
if (connection.client?.connectionState === 'connected')
  throw new Error('Sign-out retained live RPC transport');
return { signedOut: true, principalId: null, workspaceAccess: 'none', rpcConnected: false };
