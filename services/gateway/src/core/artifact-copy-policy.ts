export const GATEWAY_OWNED_DIFF_ARTIFACTS = ['diff.txt', 'diff-stat.json'] as const;
export const GATEWAY_OWNED_RUN_ARTIFACTS = ['session-metrics.json'] as const;
export const GATEWAY_OWNED_EVAL_ARTIFACTS = [
  'experiment-manifest.json',
  'packages/reference.result-package.json',
  'packages/candidate.result-package.json',
] as const;
export const WORKER_ARTIFACT_COPY_EXCLUDES = [
  'recipe-runs',
  // Raw recipe-runner screenshot spool. Curated screenshots are promoted to
  // top-level evidence files and described by evidence-manifest.json; copying
  // the spool bloats publication mirrors and makes ready/publish surfaces look
  // like they contain dozens of intentional evidence items.
  'screenshots',
  ...GATEWAY_OWNED_DIFF_ARTIFACTS,
] as const;

export const REVIEW_GATE_ARTIFACT_COPY_EXCLUDES = [
  'recipe-runs',
  // Unlike publication copyback, review gates must keep the review recipe's
  // generated screenshots available for visual inspection beside review.md.
  ...GATEWAY_OWNED_DIFF_ARTIFACTS,
] as const;
export const WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES = [
  ...GATEWAY_OWNED_EVAL_ARTIFACTS,
  // The harness source is pinned by harnessRef and can be re-materialized.
  // Copying the whole checkout bloats eval mirrors and can exceed artifact
  // tree-depth limits.
  'recipe-harness/source',
] as const;

export function isGatewayOwnedArtifactMirrorEntry(name: string): boolean {
  return (
    (GATEWAY_OWNED_DIFF_ARTIFACTS as readonly string[]).includes(name) ||
    (GATEWAY_OWNED_RUN_ARTIFACTS as readonly string[]).includes(name) ||
    name.startsWith('diff.txt.previous.') ||
    /^review-loop-\d+$/.test(name) ||
    /^(self-review|independent-review)-\d+\.(json|md)$/.test(name) ||
    /^(self-review|independent-review)-\d+$/.test(name) ||
    /^publication-gate-[a-z0-9-]+\.md$/i.test(name) ||
    /^pr-package\.(json|md)$/.test(name) ||
    name === 'workflow.mmd'
  );
}

export function isGatewayOwnedArtifactPath(artifactPath: string): boolean {
  const normalized = artifactPath.replace(/\\/g, '/');
  if (!normalized.startsWith('artifacts/')) return false;
  const artifactName = normalized.slice('artifacts/'.length);
  if (/^review-loop-\d+\//.test(artifactName)) return true;
  if (/^(self-review|independent-review)-\d+\//.test(artifactName)) return true;
  return !artifactName.includes('/') && isGatewayOwnedArtifactMirrorEntry(artifactName);
}
