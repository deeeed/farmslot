// Full-view links preserve navigation state without exposing the app's private
// loopback origin or accepting connection credentials from an external link.
const routes = new Set([
  'fleet',
  'native',
  'terminal',
  'devices',
  'dispatch',
  'roadmap',
  'backlog',
  'work-graphs',
  'prs',
  'decisions',
  'runs',
  'runs/compare',
  'evals',
  'finetune',
  'intelligence',
  'analytics',
  'config',
  'doctor',
  'violations',
]);
const entity =
  /^(run|family|slot|terminal|config)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?:\/workspace)?$/;
// These parameters select views or prefill forms. No link submits a form.
const parameters = new Set(
  (
    'a b activity file resource runId contextId history historyRun recipeRun recipeDependency ' +
    'recipeNode recipeArtifact recipeEvidenceMode recipeViewer recipeViewerMode recipeViewerPair reviewDrawer ' +
    'cmpSort cmpTab diffArtifact diffRun direction evidence evidencePreview familyId flow focus gate intent lane ' +
    'layout machines modal model panel parentRunId pr prDraft prEditor prHistory prHost project projects ' +
    'prPane prScope prSection prSort prTab prTarget publicationReviews qaInputs qaProfileId repo reviewMachine ' +
    'reviewValidationDepth run runner slot sort start_ref startRef state tab ticket trajectory transport ' +
    'validationDepth variant view window worker group promote runnerPicker'
  ).split(' '),
);

export function validViewRoute(route) {
  if (
    typeof route !== 'string' ||
    route.length > 4096 ||
    !route.startsWith('#') ||
    /[\s\\\u0000-\u001f]/.test(route)
  )
    return false;
  const [path, ...queryParts] = route.slice(1).split('?');
  if (
    (!routes.has(path) && !entity.test(path)) ||
    queryParts.length > 1 ||
    route.slice(1).includes('#')
  )
    return false;
  try {
    decodeURIComponent(route); // Reject malformed escapes before URLSearchParams normalizes them.
  } catch {
    return false;
  } // An invalid route cannot be shared or opened.
  const params = new URLSearchParams(queryParts[0] ?? '');
  for (const [key, value] of params) {
    if (!parameters.has(key) || /[\u0000-\u001f]/.test(value)) return false;
  }
  return true;
}

export function viewLinkFromRoute(route) {
  return validViewRoute(route) ? `farmslot://view/${route}` : null;
}

export function viewRouteFromLink(value) {
  if (typeof value !== 'string' || !value.startsWith('farmslot://view/')) return null;
  const route = value.slice('farmslot://view/'.length);
  return validViewRoute(route) ? route : null;
}
