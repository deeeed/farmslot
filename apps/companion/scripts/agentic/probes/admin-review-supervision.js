const modules = Array.from(__r.getModules().values());
const connection = modules
  .find((m) => m.verboseName?.endsWith('/store/connection.ts'))
  ?.publicModule.exports.useConnectionStore.getState();
const client = connection?.client;
if (
  connection?.status !== 'connected' ||
  client?.authenticatedPrincipal?.subjectKind !== 'person'
) {
  throw new Error('Connect an authenticated admin person before the supervision proof');
}
const principals = await client.request('principal.list');
const person = principals.principals.find((p) => p.id === connection.principalId);
if (!person?.roles.some((r) => r.role === 'admin' && r.scope.kind === 'global')) {
  throw new Error('Supervision proof requires admin/global');
}
const { runs } = await client.request('run.list', {});
const run = runs.find(
  (r) =>
    r.reviewWorkspace &&
    r.reviewWorkspaceSubject &&
    principals.principals.some(
      (p) => p.id === r.nativeOwnerPrincipalId && p.subject.type === 'service',
    ),
);
if (!run) throw new Error('Create a service-owned review workspace before the supervision proof');
const subject = run.reviewWorkspaceSubject;
const diff = await client.request('git.branchDiff', {
  slotId: '',
  runId: run.id,
  base: subject.baseSha,
  head: subject.headSha,
});
const after = (await client.request('run.get', { runId: run.id })).run;
if (after.nativeOwnerPrincipalId !== run.nativeOwnerPrincipalId || !Array.isArray(diff.files)) {
  throw new Error('Supervision changed the native owner or failed to read the review');
}
return {
  runId: run.id,
  viewer: connection.principalId,
  owner: after.nativeOwnerPrincipalId,
  diffFiles: diff.files.length,
  ownerUnchanged: true,
};
