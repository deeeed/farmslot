import path from 'node:path';

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

const PROJECT_TASK_ROOT_PATTERN = /^projects\/[a-zA-Z0-9._-]+\/tasks\/.+/;
const SANDBOX_TASK_ROOT_PATTERN = /^\.sandbox\/(?:[^/]+\/)*tasks\/.+/;

/** Bundled task restores must land under orchestrator or sandbox task roots only. */
export function assertApprovedTaskRestoreRelativePath(relativePath: string): void {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\//, '');
  if (!cleaned || path.isAbsolute(cleaned)) {
    throw new Error(`Unsafe task relative path: ${relativePath}`);
  }
  if (cleaned.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Unsafe task relative path: ${relativePath}`);
  }
  if (PROJECT_TASK_ROOT_PATTERN.test(cleaned) || SANDBOX_TASK_ROOT_PATTERN.test(cleaned)) {
    return;
  }
  throw new Error(
    `Task relative path must restore under projects/<name>/tasks/ or .sandbox/.../tasks/: ${relativePath}`,
  );
}

export function resolveTaskFileAbsolute(farmslotRoot: string, relativePath: string): string {
  const root = path.resolve(farmslotRoot);
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\//, '');
  if (!cleaned || path.isAbsolute(cleaned)) {
    throw new Error(`Unsafe task relative path: ${relativePath}`);
  }
  if (cleaned.split('/').some((segment) => segment === '..')) {
    throw new Error(`Unsafe task relative path: ${relativePath}`);
  }
  const resolved = path.resolve(root, cleaned);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Task path escapes farmslot root: ${relativePath}`);
  }
  return resolved;
}
