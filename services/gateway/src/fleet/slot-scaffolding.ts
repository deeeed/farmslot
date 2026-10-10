import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  execOnSlot,
  type RawProjectJson,
  resolveProjectRuntimeDirName,
  resolveProjectTaskDirName,
  type SlotVars,
} from '../core/index.js';
import {
  slotCopyFile,
  slotDeletePath,
  slotFileExists,
  slotRealpath,
  slotStat,
} from '../core/slot-io.js';
import { shellQuote } from '../core/tmux.js';

function relativeNamespace(value: string): string {
  const normalized = path.posix.normalize(value);
  if (
    path.posix.isAbsolute(value) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized === '.git' ||
    normalized.startsWith('.git/') ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(`Invalid slot scaffolding namespace: ${value}`);
  }
  return normalized.replace(/\/$/, '');
}

export function slotScaffoldingPaths(projectJson: RawProjectJson) {
  const task = relativeNamespace(resolveProjectTaskDirName(projectJson));
  const runtime = relativeNamespace(resolveProjectRuntimeDirName(projectJson));
  // Retain the pre-existing exclusions for legacy generated support files.
  return {
    task,
    runtime,
    owned: [
      ...new Set([
        task,
        runtime,
        '.task',
        '.agent',
        '.observability',
        '.omc',
        '.claude/CLAUDE.local.md',
      ]),
    ],
  };
}

/** Generated untracked files are excluded; tracked edits always remain user work. */
export function hasUserSlotChanges(porcelain: string, projectJson: RawProjectJson = {}): boolean {
  const { owned } = slotScaffoldingPaths(projectJson);
  return porcelain
    .split('\0')
    .filter(Boolean)
    .some((entry) => {
      if (!entry.startsWith('?? ')) return true;
      const name = entry.slice(3);
      return !owned.some((root) => name === root || name.startsWith(`${root}/`));
    });
}

/** Git resolves the exclude file correctly for both clones and linked worktrees. */
export async function excludeSlotScaffolding(
  vars: SlotVars,
  projectJson: RawProjectJson,
  execute = execOnSlot,
): Promise<boolean> {
  const patterns = slotScaffoldingPaths(projectJson).owned.map(
    (root) => `/${root.replace(/[\\*?\[\]]/g, '\\$&')}`,
  );
  const command = `if git -C ${shellQuote(vars.remoteRepo)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then
exclude=$(git -C ${shellQuote(vars.remoteRepo)} rev-parse --git-path info/exclude) || exit 1
case "$exclude" in /*) ;; *) exclude=${shellQuote(vars.remoteRepo)}/"$exclude" ;; esac
mkdir -p "$(dirname "$exclude")" && touch "$exclude" || exit 1
for pattern in ${patterns.map(shellQuote).join(' ')}; do
  grep -Fxq -- "$pattern" "$exclude" || printf '\\n%s\\n' "$pattern" >> "$exclude" || exit 1
done
printf installed
fi`;
  const result = await execute(vars, command);
  if (result.exitCode !== 0)
    throw new Error(
      `Cannot exclude slot scaffolding on ${vars.slotId}: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim() === 'installed';
}

export interface SlotScaffoldingArchiveOptions {
  /** Private run archive, outside the task's public evidence directory. */
  destination: string;
  beforeRemove: () => Promise<void>;
  taskRelativeDir: string | null;
}

/** Copy all sources before removing any; leave warm runtime resources in place. */
export async function archiveSlotScaffolding(
  vars: SlotVars,
  projectJson: RawProjectJson,
  options: SlotScaffoldingArchiveOptions,
): Promise<{ directory: string; roots: number }> {
  const { task, runtime } = slotScaffoldingPaths(projectJson);
  // Parked/free-slot runs can still own sibling task directories. Only the
  // released task is collected; shared task roots keep their existing retention.
  const taskRelativeDir = options.taskRelativeDir;
  const taskRoots = taskRelativeDir
    ? [...new Set([task, '.task'])].map((root) => `${root}/${relativeNamespace(taskRelativeDir)}`)
    : [];
  const roots = [
    ...new Set(
      [...taskRoots, `${runtime}/.observability`, '.agent/.observability', '.observability'].filter(
        (root): root is string => !!root,
      ),
    ),
  ];
  const repo = await slotRealpath(vars, vars.remoteRepo);
  const sources: Array<{ relative: string; absolute: string; resolved: string }> = [];
  for (const relative of roots) {
    const absolute = path.posix.join(vars.remoteRepo, relative);
    if (!(await slotFileExists(vars, absolute))) continue;
    const parent = await slotRealpath(vars, path.posix.dirname(absolute));
    if (parent !== repo && !parent.startsWith(`${repo}/`))
      throw new Error(`Scaffolding parent escapes slot repository: ${relative}`);
    sources.push({ relative, absolute, resolved: await slotRealpath(vars, absolute) });
  }
  const directory = path.join(options.destination, randomUUID());
  if (!sources.length) return { directory, roots: 0 };
  // tar preserves links as links. Copying their targets could leak a mounted
  // reference checkout or lose link metadata when the slot is cleaned.
  const created = await execOnSlot(vars, 'mktemp -d');
  if (created.exitCode !== 0 || !created.stdout.trim())
    throw new Error(`Cannot stage scaffolding archive: ${created.stderr}`);
  const temporary = created.stdout.trim();
  try {
    const remoteArchive = path.posix.join(temporary, 'scaffolding.tar');
    const packed = await execOnSlot(
      vars,
      `tar -C ${shellQuote(vars.remoteRepo)} -cf ${shellQuote(remoteArchive)} -- ${sources.map((source) => shellQuote(source.relative)).join(' ')}`,
      { timeout: 120_000 },
    );
    if (packed.exitCode !== 0) throw new Error(`Cannot pack scaffolding: ${packed.stderr}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const archive = path.join(directory, 'scaffolding.tar');
    await slotCopyFile(vars, remoteArchive, archive, {
      phase: 'mirror',
      slotId: vars.slotId,
      label: 'release-scaffolding',
    });
    if ((await stat(archive)).size !== (await slotStat(vars, remoteArchive)).size)
      throw new Error('Scaffolding archive transfer incomplete');
    await writeFile(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify({ slotId: vars.slotId, sources: sources.map((source) => source.relative) }, null, 2)}\n`,
    );
    for (const source of sources.reverse()) {
      await options.beforeRemove();
      if ((await slotRealpath(vars, source.absolute)) !== source.resolved)
        throw new Error(`Scaffolding changed during collection: ${source.relative}`);
      await slotDeletePath(vars, source.absolute);
    }
    return { directory, roots: sources.length };
  } finally {
    await slotDeletePath(vars, temporary);
  }
}
