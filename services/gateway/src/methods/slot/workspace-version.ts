import path from 'node:path';

import { slotFileExists, type SlotLocality, slotReadFile, slotStat } from '../../core/slot-io.js';

import { WORKSPACE_METADATA_POLICY as policy } from './workspace-metadata-policy.js';

interface WorkspaceVersionSource extends SlotLocality {
  remoteRepo: string;
}

function relativeTo(directory: string, file: string): string {
  return path.posix.isAbsolute(file) || file.startsWith('~/')
    ? file
    : path.posix.join(directory, file);
}

/** Metadata for passive display reuse. Acting reads always run the full probe. */
export async function localWorkspaceVersion(
  vars: WorkspaceVersionSource,
  defaultBranch: string,
): Promise<string | undefined> {
  const marker = path.posix.join(vars.remoteRepo, policy.marker);
  if (!(await slotFileExists(vars, marker))) return undefined;
  const markerStat = await slotStat(vars, marker);
  if (!Number.isFinite(markerStat.mtimeMs)) return undefined;
  let gitDir = marker;
  if (markerStat.isFile) {
    const pointer = (await slotReadFile(vars, marker)).trim();
    const target = pointer.startsWith(policy.gitPointerPrefix)
      ? pointer.slice(policy.gitPointerPrefix.length)
      : undefined;
    if (!target) return undefined;
    gitDir = relativeTo(vars.remoteRepo, target);
  } else if (!markerStat.isDirectory) return undefined;
  const head = (await slotReadFile(vars, path.posix.join(gitDir, policy.head))).trim();
  // Reftable needs Git's ref resolver; do not guess its compatibility HEAD.
  if (head === policy.reftableHead) return undefined;
  const commonFile = path.posix.join(gitDir, policy.commonDirectory);
  const commonDir = (await slotFileExists(vars, commonFile))
    ? relativeTo(gitDir, (await slotReadFile(vars, commonFile)).trim())
    : gitDir;
  const target = head.startsWith(policy.symbolicHeadPrefix)
    ? head.slice(policy.symbolicHeadPrefix.length)
    : '';
  const ref =
    target.startsWith(policy.refRootPrefix) && target.length > policy.refRootPrefix.length
      ? target
      : undefined;
  const refFile = ref ? path.posix.join(commonDir, ref) : undefined;
  const refValue =
    refFile && (await slotFileExists(vars, refFile)) ? await slotReadFile(vars, refFile) : null;
  const metadata = await Promise.all(
    policy.files.map(async (file) => {
      const directory = file.directory === 'git' ? gitDir : commonDir;
      const target = file.appendDefaultBranch
        ? path.posix.join(directory, file.path, defaultBranch)
        : path.posix.join(directory, file.path);
      if (!(await slotFileExists(vars, target))) return null;
      const value = await slotStat(vars, target);
      if (!Number.isFinite(value.mtimeMs)) throw new Error('Workspace metadata has no timestamp');
      return [value.mtimeMs, value.size];
    }),
  );
  return JSON.stringify([
    vars.machine,
    vars.remoteRepo,
    defaultBranch,
    gitDir,
    commonDir,
    markerStat.mtimeMs,
    markerStat.size,
    head,
    refValue,
    metadata,
  ]);
}
