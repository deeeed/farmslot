// Run on an open review workspace after loading its run through the normal route.
const workspace = document.querySelector('review-workspace');
const action = workspace?.querySelector('[data-testid="ask-reviewer"]');
if (!workspace?.run) throw new Error('Open a review workspace with its run first');
if (!(action instanceof HTMLAnchorElement))
  throw new Error('The retained reviewer must have an Ask reviewer link');
const query = new URLSearchParams(action.hash.split('?')[1]);
const runId = query.get('runId') ?? query.get('run');
const contextId = query.get('contextId');
const context = workspace.run.agentContexts?.find((item) => item.id === contextId);
if (runId !== workspace.run.id || context?.role !== 'review')
  throw new Error('Ask reviewer must retain the exact run and reviewer context');
const bounds = action.getBoundingClientRect();
if (bounds.height < 44) throw new Error('Ask reviewer needs a 44px touch target');
if (workspace.scrollWidth > workspace.clientWidth + 1)
  throw new Error('Review workspace overflows its available width');
if (workspace.getBoundingClientRect().right > innerWidth + 1)
  throw new Error('Review workspace extends beyond the viewport');
let reconnectedDuringRefresh = false;
if (location.hash.startsWith('#dev/review-workspace')) {
  if (workspace.runId !== 'mock-run-1') throw new Error('Reconnect proof requires the fixture run');
  const module = performance
    .getEntriesByType('resource')
    .find((entry) => entry.name.includes('/src/gateway-client.ts'));
  if (!module) throw new Error('The page gateway module is unavailable');
  const { gateway } = await import(module.name);
  if (gateway.connectionState !== 'connected') throw new Error('Connect the gateway first');
  const refresh = [...workspace.querySelectorAll('button')].find((button) =>
    button.textContent.includes('Refresh review'),
  );
  if (!refresh || refresh.disabled) throw new Error('Refresh review is unavailable');
  refresh.click();
  // Interrupt the real client transport while its refresh request is pending.
  gateway.reconnect();
  const deadline = Date.now() + 15000;
  while (
    Date.now() < deadline &&
    (gateway.connectionState !== 'connected' || workspace._refreshing || workspace._isRecovering)
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
  await workspace.updateComplete;
  if (gateway.connectionState !== 'connected' || workspace._refreshing || workspace._isRecovering)
    throw new Error('Review workspace did not recover its connection');
  if (!workspace._refreshError || !workspace.querySelector('[role="alert"]'))
    throw new Error('An interrupted refresh must retain a visible retry error');
  if (refresh.disabled) throw new Error('Refresh retry must remain available');
  reconnectedDuringRefresh = true;
}
const post = workspace.querySelector('.rw-btn-post');
if (workspace._refreshError && post && !post.disabled)
  throw new Error('Post must stay disabled after a failed review refresh');
return {
  href: action.getAttribute('href'),
  runId,
  contextId,
  height: bounds.height,
  workspaceWidth: workspace.clientWidth,
  viewportWidth: innerWidth,
  reconnectedDuringRefresh,
  refreshFailed: Boolean(workspace._refreshError),
  postDisabled: post?.disabled ?? null,
};
