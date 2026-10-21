// Run with scripts/cdp.mjs eval <live-run-route> --file probes/run-canvas-activity.js.
function findAll(root, selector) {
  return [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')]
      .filter((element) => element.shadowRoot)
      .flatMap((element) => findAll(element.shadowRoot, selector)),
  ];
}

const deadline = Date.now() + 10000;
let pipeline;
do {
  pipeline = findAll(document, 'run-pipeline')[0];
  if (pipeline?.run && pipeline.shadowRoot) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
} while (Date.now() < deadline);
if (!pipeline?.run || !pipeline.shadowRoot) throw new Error('Live run canvas is not loaded');
await pipeline.updateComplete;
const root = pipeline.shadowRoot;
const nodes = [...root.querySelectorAll('.pipeline-node')];
const running = nodes.filter((node) => node.dataset.status === 'running');
const blocked = pipeline.run.status === 'blocked';
const waiting =
  blocked &&
  pipeline.run.decisions.some(
    (decision) => decision.type === 'engine_human_gate' && !decision.resolvedAt,
  );
if (running.length !== (blocked ? 0 : 1))
  throw new Error(`Unexpected running nodes: ${running.length}`);
const active = blocked ? nodes.find((node) => node.dataset.status === 'blocked') : running[0];
if (!active) throw new Error('Current activity node is missing');
const liveActors = (pipeline.run.agentContexts ?? []).filter(
  (context) =>
    ['review', 'review-fix'].includes(context.role) &&
    ['working', 'launching'].includes(context.status),
);
if (!blocked && liveActors.length === 1) {
  const expected = liveActors[0].role === 'review-fix' ? 'worker fix' : 'reviewer';
  if (!active.textContent.includes(expected))
    throw new Error('The running node does not match the working actor');
}
const pulseCount = root.querySelectorAll('.node-running-anim').length;
if (pulseCount !== (blocked ? 0 : 1)) throw new Error(`Unexpected pulsing nodes: ${pulseCount}`);
const now = [...root.querySelectorAll('text')].filter((text) => text.textContent.trim() === 'now');
const clip = active.querySelector('clipPath rect');
if (blocked && !waiting) {
  if (now.length) throw new Error('A blocked worker still has a running now marker');
} else if (
  now.length !== 1 ||
  !clip ||
  Number(now[0].getAttribute('x')) !==
    Number(clip.getAttribute('x')) + Number(clip.getAttribute('width')) / 2
)
  throw new Error('The now marker does not point at the running node');
if (nodes.some((node) => !node.querySelector('g[clip-path]')))
  throw new Error('A node can paint its detail over its neighbors');

const overlaps = [];
for (const node of nodes) {
  const label = node.querySelector('.node-label')?.getBoundingClientRect();
  if (!label) continue;
  for (const meta of node.querySelectorAll('.node-meta, .node-elapsed')) {
    const rect = meta.getBoundingClientRect();
    if (
      rect.width &&
      rect.left < label.right &&
      rect.right > label.left &&
      rect.top < label.bottom &&
      rect.bottom > label.top
    )
      overlaps.push(node.dataset.nodeId);
  }
}
if (overlaps.length) throw new Error(`Node label overlaps elapsed time: ${overlaps.join(', ')}`);
if ([...root.querySelectorAll('text')].some((text) => text.textContent.includes('superseded')))
  throw new Error('A superseded decision action is still painted outside its tooltip');
const decisionLabels = [...root.querySelectorAll('.pipeline-decision text[y="17"]')];
for (let index = 0; index < decisionLabels.length; index++) {
  const left = decisionLabels[index].getBoundingClientRect();
  for (const next of decisionLabels.slice(index + 1)) {
    const right = next.getBoundingClientRect();
    if (
      left.left < right.right &&
      left.right > right.left &&
      left.top < right.bottom &&
      left.bottom > right.top
    )
      throw new Error('Decision labels overlap');
  }
}

root.querySelector('svg').scrollIntoView({ block: 'center', behavior: 'instant' });
return {
  runId: pipeline.run.id,
  status: pipeline.run.status,
  workingActors: liveActors.map((context) => context.role),
  header: (
    root.querySelector('.pipeline-activity') ?? findAll(document, '.run-activity-label')[0]
  )?.textContent.trim(),
  activeNode: blocked ? null : active.dataset.nodeId,
  waitingNode: waiting ? active.dataset.nodeId : null,
  blockedNode: blocked ? active.dataset.nodeId : null,
  pulsingNodes: pulseCount,
  boundedNodes: nodes.length,
  completedReviews: nodes.filter(
    (node) =>
      node.dataset.nodeId.includes('publication-review') && node.textContent.includes('✓ Done'),
  ).length,
  skippedReasons: [...root.querySelectorAll('.pipeline-decision title')]
    .map((title) => title.textContent)
    .filter((text) => text.includes('superseded')),
};
