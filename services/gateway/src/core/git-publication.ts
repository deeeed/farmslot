import type { SlotVars } from './config.js';
import type { execOnSlot } from './exec.js';
import { withFarmGitConfig } from './farm-git.js';
import { shellQuote } from './tmux.js';

interface UnpushedCommitOptions {
  preservedByLocalBranch?: boolean;
  patchBase?: string;
}

/** Commits not retained by remote refs or an allowed local branch. Git failures refuse. */
export async function findUnpushedSlotCommits(
  vars: SlotVars,
  ref = 'HEAD',
  exec: typeof execOnSlot,
  options: UnpushedCommitOptions = {},
): Promise<string[]> {
  const result = await exec(
    vars,
    withFarmGitConfig(
      `git -C ${shellQuote(vars.remoteRepo)} log --format='%H %s'${options.patchBase ? '' : ' --max-count=5'} ${shellQuote(ref)} --not --remotes${options.preservedByLocalBranch ? ' --branches' : ''}`,
    ),
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Cannot verify commits on ${vars.slotId} at ${ref}: ${result.stderr || result.stdout}`,
    );
  const commits = result.stdout.trim().split('\n').filter(Boolean);
  if (!commits.length || !options.patchBase) return commits;
  const cherry = await exec(
    vars,
    withFarmGitConfig(
      `git -C ${shellQuote(vars.remoteRepo)} cherry ${shellQuote(options.patchBase)} ${shellQuote(ref)}`,
    ),
  );
  if (cherry.exitCode !== 0)
    throw new Error(
      `Cannot verify merged patches on ${vars.slotId}: ${cherry.stderr || cherry.stdout}`,
    );
  const merged = new Set(
    cherry.stdout
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2)),
  );
  // Filter before limiting the error details, so merged tips cannot hide older unpublished work.
  return commits.filter((line) => !merged.has(line.split(' ', 1)[0])).slice(0, 5);
}
