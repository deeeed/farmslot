import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TASK_DIR } from '@farmslot/protocol';

import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';
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
  const configuredRuntime = resolveProjectRuntimeDirName(projectJson);
  const externalRuntime =
    path.posix.isAbsolute(configuredRuntime) ||
    configuredRuntime === '~' ||
    configuredRuntime.startsWith('~/');
  const runtime = externalRuntime ? configuredRuntime : relativeNamespace(configuredRuntime);
  // Retain the pre-existing exclusions for legacy generated support files.
  return {
    task,
    runtime,
    owned: [
      ...new Set([
        task,
        ...(externalRuntime ? [] : [runtime]),
        DEFAULT_TASK_DIR,
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
  /**
   * The release already collected the task's `artifacts/`. Archiving them again downloaded
   * the same 0.5-1 GB a second time and outlasted the teardown timeout (F298).
   */
  excludeArtifacts?: boolean;
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
    ? [...new Set([task, DEFAULT_TASK_DIR])].map(
        (root) => `${root}/${relativeNamespace(taskRelativeDir)}`,
      )
    : [];
  const roots = [
    ...new Set([
      ...taskRoots,
      ...(path.posix.isAbsolute(runtime) || runtime === '~' || runtime.startsWith('~/')
        ? []
        : [`${runtime}/.observability`]),
      '.agent/.observability',
      '.observability',
    ]),
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
  const configuredExternal = path.posix.join(
    runnerRuntimeDir(vars.remoteRepo, runtime),
    '.observability',
  );
  let external: string | null = null;
  if (await slotFileExists(vars, configuredExternal)) {
    const resolved = await slotRealpath(vars, configuredExternal);
    const expected = path.posix.join(
      await slotRealpath(vars, path.posix.dirname(configuredExternal)),
      '.observability',
    );
    if (resolved !== expected)
      throw new Error('External runner observations must be an owned directory');
    external = resolved;
    sources.push({ relative: 'runner-observability', absolute: external, resolved });
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
    const checkoutSources = sources.filter((source) => source.absolute !== external);
    const excluded = options.excludeArtifacts
      ? checkoutSources
          .filter((source) => taskRoots.includes(source.relative))
          .map((source) => `--exclude ${shellQuote(`${source.relative}/artifacts`)} `)
          .join('')
      : '';
    const packed = await execOnSlot(
      vars,
      `tar -C ${shellQuote(vars.remoteRepo)} ${excluded}-cf ${shellQuote(remoteArchive)} ${checkoutSources.length ? `-- ${checkoutSources.map((source) => shellQuote(source.relative)).join(' ')}` : '-T /dev/null'}`,
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
    if (external) {
      const externalArchive = path.posix.join(temporary, 'runner-observability.tar');
      const packedExternal = await execOnSlot(
        vars,
        `tar -C ${shellQuote(external)} -cf ${shellQuote(externalArchive)} .`,
        { timeout: 120_000 },
      );
      if (packedExternal.exitCode !== 0)
        throw new Error(`Cannot pack runner observations: ${packedExternal.stderr}`);
      await slotCopyFile(vars, externalArchive, path.join(directory, 'runner-observability.tar'), {
        phase: 'mirror',
        slotId: vars.slotId,
        label: 'release-observability',
      });
      if (
        (await stat(path.join(directory, 'runner-observability.tar'))).size !==
        (await slotStat(vars, externalArchive)).size
      )
        throw new Error('Runner observations archive transfer incomplete');
    }
    await writeFile(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify({ slotId: vars.slotId, sources: sources.map((source) => source.relative) }, null, 2)}\n`,
    );
    for (const source of [
      ...sources.filter((source) => source.absolute !== external).reverse(),
      ...sources.filter((source) => source.absolute === external),
    ]) {
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
