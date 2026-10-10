import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RecipeSourceProvenance } from '@farmslot/protocol';

import { sourceIsDirty, type SourceProvenanceSnapshot } from './execution-provenance.js';

const execFileAsync = promisify(execFile);

export async function gitLibraryProvenance(
  root: string,
  snapshot?: SourceProvenanceSnapshot,
): Promise<Pick<RecipeSourceProvenance, 'revision' | 'dirty'>> {
  try {
    const { stdout: tracked } = await execFileAsync('git', ['-C', root, 'ls-files', '--', '.'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (!tracked.trim()) return {};
    if (snapshot) {
      return snapshot.head ? { revision: snapshot.head, dirty: sourceIsDirty(snapshot) } : {};
    }
    const [{ stdout: revision }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        timeout: 5_000,
      }),
      execFileAsync(
        'git',
        ['-C', root, 'status', '--porcelain=v1', '--untracked-files=normal', '--', '.'],
        {
          encoding: 'utf8',
          timeout: 5_000,
        },
      ),
    ]);
    const trimmedRevision = revision.trim();
    return trimmedRevision ? { revision: trimmedRevision, dirty: status.trim().length > 0 } : {};
  } catch {
    // A library may be a plain directory or an unavailable checkout; recipe
    // discovery still works and provenance remains explicitly absent.
    return {};
  }
}
