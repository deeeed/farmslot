import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RecipeSourceProvenance } from '@farmslot/protocol';

import { countCallWork } from './call-timings.js';
import { sourceIsDirty, type SourceProvenanceSnapshot } from './execution-provenance.js';
import { gitReadArgs, gitReadEnv, gitTopLevel, readHeadCommit } from './git-read.js';

const execFileAsync = promisify(execFile);

function readGitAsync(root: string, args: string[]) {
  countCallWork('git');
  return execFileAsync('git', gitReadArgs(['-C', root, ...args]), {
    encoding: 'utf8',
    env: gitReadEnv(),
    timeout: 5_000,
  });
}

export async function gitLibraryProvenance(
  root: string,
  snapshot?: SourceProvenanceSnapshot,
): Promise<Pick<RecipeSourceProvenance, 'revision' | 'dirty'>> {
  try {
    const { stdout: tracked } = await readGitAsync(root, ['ls-files', '--', '.']);
    if (!tracked.trim()) return {};
    if (snapshot) {
      return snapshot.head ? { revision: snapshot.head, dirty: sourceIsDirty(snapshot) } : {};
    }
    const topLevel = gitTopLevel(root);
    const head = topLevel ? readHeadCommit(topLevel) : undefined;
    const [revision, { stdout: status }] = await Promise.all([
      head ?? readGitAsync(root, ['rev-parse', 'HEAD']).then(({ stdout }) => stdout),
      readGitAsync(root, ['status', '--porcelain=v1', '--untracked-files=normal', '--', '.']),
    ]);
    const trimmedRevision = revision.trim();
    return trimmedRevision ? { revision: trimmedRevision, dirty: status.trim().length > 0 } : {};
  } catch {
    // A library may be a plain directory or an unavailable checkout; recipe
    // discovery still works and provenance remains explicitly absent.
    return {};
  }
}
