import path from 'node:path';

import { slotFileExists, type SlotLocality, slotReadFile, slotStat } from '../../core/slot-io.js';

import {
  WORKSPACE_METADATA_POLICY as policy,
  type WorkspaceMetadataVersion,
} from './workspace-metadata-policy.js';

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
  previous?: WorkspaceMetadataVersion,
): Promise<WorkspaceMetadataVersion | undefined> {
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
  const version = JSON.stringify([
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
  // Reuse the packed-ref index only when the complete metadata generation is unchanged.
  if (previous?.version === version) return previous;
  let ancestryCacheable = policy.files.every(
    (file, index) => !file.blocksAncestryCache || metadata[index] === null,
  );
  const packedIndex = policy.files.findIndex(
    (file) => file.directory === 'common' && file.path === policy.packedRefs,
  );
  if (ancestryCacheable && metadata[packedIndex] != null) {
    const packed = await slotReadFile(vars, path.posix.join(commonDir, policy.packedRefs));
    ancestryCacheable = !packed.split('\n').some((line) => {
      if (line.startsWith('#') || line.startsWith('^')) return false;
      return (
        line
          .trim()
          .split(/\s+/, 2)[1]
          ?.startsWith(policy.replacementRefs + '/') === true
      );
    });
  }
  const alternatesIndex = policy.files.findIndex(
    (file) => file.directory === 'common' && file.path === policy.alternates,
  );
  return {
    version,
    ancestryCacheable,
    ...(metadata[alternatesIndex] !== null
      ? { alternatesPath: path.posix.join(commonDir, policy.alternates) }
      : {}),
  };
}
