import type { RunBundleProfile } from '../contracts/run-bundles.js';
import type { Run } from '../contracts/runs.js';

const TERMINAL_IMPORT_STATUSES = new Set(['done', 'failed', 'cancelled', 'blocked']);

/** Strip volatile monitor/engine fields for reference-profile export. */
export function sanitizeRunForBundleExport(run: Run, profile: RunBundleProfile): Run {
  const cloned = structuredClone(run);
  if (profile === 'reference' || profile === 'family') {
    delete cloned.monitorState;
    if (cloned.engineState) {
      const flags = cloned.engineState.flags;
      cloned.engineState = {
        ...(cloned.engineState.evalExperiment
          ? { evalExperiment: cloned.engineState.evalExperiment }
          : {}),
        ...(cloned.engineState.publishGate?.packageArtifactPath
          ? {
              publishGate: {
                packageArtifactPath: cloned.engineState.publishGate.packageArtifactPath,
                packageId: cloned.engineState.publishGate.packageId,
                packageHash: cloned.engineState.publishGate.packageHash,
              },
            }
          : {}),
        ...(flags ? { flags: { skipPrepare: flags.skipPrepare } } : {}),
      };
      if (Object.keys(cloned.engineState).length === 0) delete cloned.engineState;
    }
    delete cloned.recoveryAttempts;
    delete cloned.recoveryProposal;
    delete cloned.liveRecipeContext;
    if (!TERMINAL_IMPORT_STATUSES.has(cloned.status)) {
      cloned.status = 'done';
    }
  }
  delete cloned.importProvenance;
  delete cloned.readOnly;
  return cloned;
}

export function taskRelativePathFromAbsolute(
  farmslotRoot: string,
  taskFile: string | null | undefined,
): string | null {
  if (!taskFile?.trim()) return null;
  const root = farmslotRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const normalized = taskFile.replace(/\\/g, '/');
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  const projectsIdx = normalized.indexOf('/projects/');
  if (projectsIdx >= 0) return normalized.slice(projectsIdx + 1);
  const sandboxIdx = normalized.indexOf('/.sandbox/');
  if (sandboxIdx >= 0) return normalized.slice(sandboxIdx + 1);
  return null;
}

export function resolveTaskFileAbsolute(farmslotRoot: string, relativePath: string): string {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\//, '');
  return `${farmslotRoot.replace(/\\/g, '/').replace(/\/$/, '')}/${cleaned}`;
}
