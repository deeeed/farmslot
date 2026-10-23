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
  refreshFailed: Boolean(workspace._refreshError),
  postDisabled: post?.disabled ?? null,
};
