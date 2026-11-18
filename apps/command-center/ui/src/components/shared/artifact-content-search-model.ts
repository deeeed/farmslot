import { isRunArtifactSearchablePath, type RunArtifactSearchParams } from '@farmslot/protocol';

/** Keep the search on exactly the retained source used by the artifact links. */
export function artifactContentSearchParams(
  query: string,
  links: readonly string[],
  origin = 'http://artifact.invalid',
): RunArtifactSearchParams | undefined {
  let result: RunArtifactSearchParams | undefined;
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link, origin);
    } catch {
      return undefined;
    }
    if (url.origin !== new URL(origin).origin) return undefined;
    if (url.pathname !== '/api/run-artifact') return undefined;
    const runId = url.searchParams.get('runId');
    const path = url.searchParams.get('path');
    if (!runId || !path) return undefined;
    if (!isRunArtifactSearchablePath(path)) continue;
    const bundleDigest = url.searchParams.get('bundleDigest') ?? undefined;
    const recipeRunId = url.searchParams.get('recipeRunId') ?? undefined;
    const decisionId = url.searchParams.get('decisionId') ?? undefined;
    if (
      result &&
      (result.runId !== runId ||
        result.bundleDigest !== bundleDigest ||
        result.recipeRunId !== recipeRunId ||
        result.decisionId !== decisionId)
    )
      return undefined;
    result ??= {
      runId,
      query,
      paths: [],
      ...(bundleDigest ? { bundleDigest } : {}),
      ...(recipeRunId ? { recipeRunId } : {}),
      ...(decisionId ? { decisionId } : {}),
    };
    const version = url.searchParams.get('v');
    if (version) {
      if (result.versions?.[path] && result.versions[path] !== version) return undefined;
      (result.versions ??= {})[path] = version;
    }
    result.paths.push(path);
  }
  if (result) {
    result.paths = [...new Set(result.paths)].sort().slice(0, 500);
    if (result.versions)
      result.versions = Object.fromEntries(
        result.paths.flatMap((path) =>
          result!.versions?.[path] ? [[path, result!.versions[path]]] : [],
        ),
      );
  }
  return result;
}

/** Keep large newline-heavy logs from mounting an unbounded number of preview rows. */
export function artifactContentPreviewWindow(text: string, line: number) {
  const lines = text.split('\n');
  const start = Math.max(0, Math.min(Math.max(0, lines.length - 201), line - 101));
  return { firstLine: start + 1, totalLines: lines.length, lines: lines.slice(start, start + 201) };
}
