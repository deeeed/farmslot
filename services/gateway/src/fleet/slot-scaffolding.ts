import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
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
   * The release copied every file of the configured task root's `artifacts/`. Archiving
   * them again downloaded the same 0.5-1 GB a second time and outlasted the teardown
   * timeout (F298). Legacy task roots were not copied, so they stay in the archive.
   */
  artifactsCollected?: boolean;
  /** Where nested checkouts are moved on the slot host. Default: `$HOME/slot-retained`. */
  retainedBase?: string;
  /** Largest archive the release downloads. Default: SCAFFOLDING_ARCHIVE_MAX_BYTES. */
  maxArchiveBytes?: number;
}

/**
 * A scaffolding archive holds task notes and observations once rebuildable content is left out.
 * Anything larger is refused before download: audiolab-6's retried releases streamed six 6 GB
 * archives at once into macwork's last free space (F310).
 */
export const SCAFFOLDING_ARCHIVE_MAX_BYTES = 2 * 1024 ** 3;

const collectionsInFlight = new Set<string>();

/**
 * Directories an install or build recreates. The archive lists them instead of packing them:
 * macpro-audiolab-4's task held a worker's 14 GB baseline checkout, mostly node_modules and
 * Android builds, and packing it outlasted the 120 s tar budget (F310).
 */
const REBUILDABLE_DIR_NAMES = ['node_modules', 'Pods', '.gradle', '.cxx'];
const REBUILDABLE_DIR_PATHS = ['*/android/build', '*/android/*/build', '*/ios/build'];

interface SkippedScaffolding {
  path: string;
  kind: 'checkout' | 'rebuildable';
  sizeBytes: number | null;
  /** Checkouts only: where the release moved it on the slot host. */
  retainedAt?: string;
  linkedWorktree?: boolean;
  /** Checkouts only: the repository whose objects and refs this checkout uses. */
  commonDir?: string;
  /** A clone's registered linked worktrees, by absolute path before the move. */
  worktrees?: string[];
  dirtyFiles?: number;
  stashes?: number;
  remote?: string;
  head?: string;
}

/**
 * Nested Git checkouts and rebuildable directories under the released task roots. A checkout is
 * never deleted: a clean, pushed one still held stashes in its common repository and gigabytes
 * of ignored prebuilt libraries on audiolab-4, so the release moves it aside on the slot host.
 * `retainedRoot` is null when no checkout exists or when it would cross a volume.
 */
async function inventoryRebuildableScaffolding(
  vars: SlotVars,
  taskRoots: string[],
  retainedBase: string | undefined,
): Promise<{ skipped: SkippedScaffolding[]; retainedRoot: string | null; repoRealpath: string }> {
  if (!taskRoots.length) return { skipped: [], retainedRoot: null, repoRealpath: '' };
  const names = REBUILDABLE_DIR_NAMES.map((name) => `-name ${shellQuote(name)}`).join(' -o ');
  const paths = REBUILDABLE_DIR_PATHS.map((glob) => `-path ${shellQuote(glob)}`).join(' -o ');
  const script = [
    `cd ${shellQuote(vars.remoteRepo)} || exit 1`,
    `for root in ${taskRoots.map(shellQuote).join(' ')}; do`,
    '  [ -d "$root" ] || continue',
    `  find "$root" -mindepth 1 -path "$root/artifacts" -prune -o -type d \\( ${names} -o ${paths} \\) -print -prune -o -type d -exec test -e '{}/.git' \\; -print -prune 2>/dev/null`,
    'done | while IFS= read -r dir; do',
    '  size="$(du -sk "$dir" 2>/dev/null | cut -f1)"',
    '  if [ ! -e "$dir/.git" ]; then printf "R\\t%s\\t%s\\n" "$dir" "$size"; continue; fi',
    '  linked=0; [ -f "$dir/.git" ] && linked=1',
    '  dirty="$(git -C "$dir" status --porcelain --untracked-files=all --ignore-submodules=none 2>/dev/null | wc -l | tr -d " ")"',
    '  stashes="$(git -C "$dir" stash list 2>/dev/null | wc -l | tr -d " ")"',
    '  common="$(cd "$(git -C "$dir" rev-parse --git-common-dir)" 2>/dev/null && pwd -P)"',
    '  printf "C\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$dir" "$size" "$linked" "$dirty" "$stashes" "$(git -C "$dir" remote get-url origin 2>/dev/null)" "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" "$(df -P "$dir" | awk \'NR==2{print $1}\')" "$common"',
    '  [ "$linked" = 1 ] || git -C "$dir" worktree list --porcelain 2>/dev/null | sed -n "s/^worktree //p" | while IFS= read -r tree; do printf "W\\t%s\\t%s\\n" "$dir" "$(cd "$tree" 2>/dev/null && pwd -P || printf %s "$tree")"; done',
    'done',
    `base=${retainedBase ? shellQuote(retainedBase) : '"$HOME/slot-retained"'}`,
    // An existing retention directory may be a link or mount onto another volume.
    'probe="$base"; [ -e "$probe" ] || probe="$(dirname "$base")"',
    'printf "V\\t%s\\t%s\\t%s\\n" "$(pwd -P)" "$(df -P "$probe" | awk \'NR==2{print $1}\')" "$base"',
  ].join('\n');
  const result = await execOnSlot(vars, script, { timeout: 120_000 });
  if (result.exitCode !== 0) throw new Error(`Cannot inventory scaffolding: ${result.stderr}`);
  const skipped: SkippedScaffolding[] = [];
  const devices = new Map<string, string>();
  let volume: string[] = [];
  for (const line of result.stdout.split('\n')) {
    const [kind, ...fields] = line.split('\t');
    if (kind === 'V') volume = fields;
    if (kind === 'W') {
      const checkout = skipped.find((entry) => entry.path === fields[0]);
      if (checkout && fields[1]) (checkout.worktrees ??= []).push(fields[1]);
    }
    const [dir, size, linked, dirty, stashes, remote, head, device, commonDir] = fields;
    if (!dir || (kind !== 'R' && kind !== 'C')) continue;
    const sizeBytes = /^\d+$/.test(size ?? '') ? Number(size) * 1024 : null;
    if (kind === 'R') skipped.push({ path: dir, kind: 'rebuildable', sizeBytes });
    else {
      devices.set(dir, device ?? '');
      skipped.push({
        path: dir,
        kind: 'checkout',
        sizeBytes,
        linkedWorktree: linked === '1',
        ...(commonDir ? { commonDir } : {}),
        dirtyFiles: Number(dirty) || 0,
        stashes: Number(stashes) || 0,
        ...(remote ? { remote } : {}),
        ...(head ? { head } : {}),
      });
    }
  }
  if (!devices.size) return { skipped, retainedRoot: null, repoRealpath: volume[0] ?? '' };
  const [repoRealpath, baseDevice, base] = volume;
  // A move across volumes would copy and delete gigabytes instead of renaming them.
  const crossing = [...devices].find(([, device]) => !device || device !== baseDevice);
  if (!repoRealpath || !base || !baseDevice || crossing)
    throw new Error(
      `Nested checkouts cannot be moved aside: ${base || 'the retention directory'} is not on the volume of ${crossing?.[0] ?? 'the slot repository'}`,
    );
  return { skipped, retainedRoot: path.posix.join(base, vars.slotId), repoRealpath };
}

/**
 * Move the released task's nested checkouts into the slot's retention directory and repair their
 * worktree links: a clone repairs every worktree of it that moved too, wherever it was nested; a
 * linked worktree of a repository outside the task repairs its own link back.
 */
async function retainNestedCheckouts(
  vars: SlotVars,
  checkouts: SkippedScaffolding[],
  retainedDir: string,
  repoRealpath: string,
): Promise<void> {
  const moved = checkouts.map((entry) => ({
    entry,
    from: path.posix.join(repoRealpath, entry.path),
    to: path.posix.join(retainedDir, entry.path),
  }));
  const relocate = (target: string) => {
    const owner = moved.find(({ from }) => target === from || target.startsWith(`${from}/`));
    return owner && `${owner.to}${target.slice(owner.from.length)}`;
  };
  const repairs = moved.flatMap(({ entry, to }) => {
    if (!entry.linkedWorktree) {
      const trees = (entry.worktrees ?? []).flatMap((tree) => {
        const relocated = relocate(tree);
        return relocated && relocated !== to ? [relocated] : [];
      });
      return trees.length
        ? [`git -C ${shellQuote(to)} worktree repair ${trees.map(shellQuote).join(' ')}`]
        : [];
    }
    // Its repository moved too, so that clone's repair above covers it.
    if (entry.commonDir && relocate(entry.commonDir)) return [];
    return [`git -C ${shellQuote(to)} worktree repair`];
  });
  const result = await execOnSlot(
    vars,
    [
      'set -e',
      `cd ${shellQuote(vars.remoteRepo)}`,
      ...moved.flatMap(({ entry, to }) => [
        `mkdir -p ${shellQuote(path.posix.dirname(to))}`,
        `mv ${shellQuote(entry.path)} ${shellQuote(to)}`,
        `printf '%s\\t%s\\n' ${shellQuote(entry.path)} ${shellQuote(to)} >> ${shellQuote(path.posix.join(retainedDir, 'RETAINED.tsv'))}`,
      ]),
      ...repairs,
    ].join('\n'),
    { timeout: 120_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Cannot move nested checkouts aside: ${result.stderr}`);
}

/**
 * What a slot's retention directory holds, for fleet status. Measured after every release
 * attempt, so a failed release or an operator's cleanup still shows the current totals.
 */
export async function measureSlotRetention(
  vars: SlotVars,
  retainedBase?: string,
): Promise<{ items: number; bytes: number } | null> {
  const base = retainedBase ? shellQuote(retainedBase) : '"$HOME/slot-retained"';
  const root = `${base}/${shellQuote(vars.slotId)}`;
  const result = await execOnSlot(
    vars,
    `[ -d ${root} ] || exit 0; printf '%s\\t%s\\n' "$(cat ${root}/*/RETAINED.tsv 2>/dev/null | wc -l | tr -d ' ')" "$(du -sk ${root} | cut -f1)"`,
    { timeout: 60_000 },
  );
  if (result.exitCode !== 0) throw new Error(`Cannot measure retained checkouts: ${result.stderr}`);
  const [items, kb] = result.stdout.trim().split('\t');
  return Number(items) > 0 ? { items: Number(items), bytes: (Number(kb) || 0) * 1024 } : null;
}

/**
 * Move a task's nested checkouts aside without collecting its scaffolding, for releases that
 * keep the agents and still delete the task directory.
 */
export async function retainTaskCheckouts(
  vars: SlotVars,
  projectJson: RawProjectJson,
  taskRelativeDir: string,
  retainedBase?: string,
): Promise<void> {
  const { task } = slotScaffoldingPaths(projectJson);
  const taskRoots = [...new Set([task, DEFAULT_TASK_DIR])].map(
    (root) => `${root}/${relativeNamespace(taskRelativeDir)}`,
  );
  const { skipped, retainedRoot, repoRealpath } = await inventoryRebuildableScaffolding(
    vars,
    taskRoots,
    retainedBase,
  );
  const checkouts = skipped.filter((entry) => entry.kind === 'checkout');
  if (checkouts.length && retainedRoot)
    await retainNestedCheckouts(
      vars,
      checkouts,
      path.posix.join(retainedRoot, randomUUID()),
      repoRealpath,
    );
}

type ScaffoldingArchive = { directory: string; roots: number };

/**
 * Copy all sources before removing any; leave warm runtime resources in place. One collection
 * per slot at a time: a retry loop ran several on audiolab-6 at once (F310).
 */
export async function archiveSlotScaffolding(
  vars: SlotVars,
  projectJson: RawProjectJson,
  options: SlotScaffoldingArchiveOptions,
): Promise<ScaffoldingArchive> {
  if (collectionsInFlight.has(vars.slotId))
    throw new Error(`A scaffolding collection for ${vars.slotId} is already running`);
  collectionsInFlight.add(vars.slotId);
  try {
    return await collectSlotScaffolding(vars, projectJson, options);
  } finally {
    collectionsInFlight.delete(vars.slotId);
  }
}

async function collectSlotScaffolding(
  vars: SlotVars,
  projectJson: RawProjectJson,
  options: SlotScaffoldingArchiveOptions,
): Promise<ScaffoldingArchive> {
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
  const { skipped, retainedRoot, repoRealpath } = await inventoryRebuildableScaffolding(
    vars,
    sources
      .filter((source) => taskRoots.includes(source.relative))
      .map((source) => source.relative),
    options.retainedBase,
  );
  const retainedDir = retainedRoot && path.posix.join(retainedRoot, path.basename(directory));
  for (const entry of skipped)
    if (entry.kind === 'checkout' && retainedDir)
      entry.retainedAt = path.posix.join(retainedDir, entry.path);
  // tar preserves links as links. Copying their targets could leak a mounted
  // reference checkout or lose link metadata when the slot is cleaned.
  const created = await execOnSlot(vars, 'mktemp -d');
  if (created.exitCode !== 0 || !created.stdout.trim())
    throw new Error(`Cannot stage scaffolding archive: ${created.stderr}`);
  const temporary = created.stdout.trim();
  // A failed transfer leaves its partial download; only a finished archive stays.
  let archived = false;
  try {
    const remoteArchive = path.posix.join(temporary, 'scaffolding.tar');
    const checkoutSources = sources.filter((source) => source.absolute !== external);
    const collected = taskRelativeDir && `${task}/${relativeNamespace(taskRelativeDir)}`;
    const excluded = [
      ...(options.artifactsCollected &&
      collected &&
      checkoutSources.some((source) => source.relative === collected)
        ? [`${collected}/artifacts`]
        : []),
      ...skipped.map((entry) => entry.path),
    ]
      .map((pattern) => `--exclude ${shellQuote(pattern)} `)
      .join('');
    const packed = await execOnSlot(
      vars,
      `tar -C ${shellQuote(vars.remoteRepo)} ${excluded}-cf ${shellQuote(remoteArchive)} ${checkoutSources.length ? `-- ${checkoutSources.map((source) => shellQuote(source.relative)).join(' ')}` : '-T /dev/null'}`,
      { timeout: 120_000 },
    );
    if (packed.exitCode !== 0) throw new Error(`Cannot pack scaffolding: ${packed.stderr}`);
    const archiveBytes = (await slotStat(vars, remoteArchive)).size;
    const maxArchiveBytes = options.maxArchiveBytes ?? SCAFFOLDING_ARCHIVE_MAX_BYTES;
    if (archiveBytes > maxArchiveBytes)
      throw new Error(
        `Scaffolding archive is ${Math.ceil(archiveBytes / 1024 ** 2)} MB, over the ${Math.floor(maxArchiveBytes / 1024 ** 2)} MB limit`,
      );
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
      `${JSON.stringify({ slotId: vars.slotId, sources: sources.map((source) => source.relative), skipped }, null, 2)}\n`,
    );
    archived = true;
    for (const source of [
      ...sources.filter((source) => source.absolute !== external).reverse(),
      ...sources.filter((source) => source.absolute === external),
    ]) {
      await options.beforeRemove();
      if ((await slotRealpath(vars, source.absolute)) !== source.resolved)
        throw new Error(`Scaffolding changed during collection: ${source.relative}`);
      const checkouts = skipped.filter(
        (entry) => entry.kind === 'checkout' && entry.path.startsWith(`${source.relative}/`),
      );
      if (checkouts.length && retainedDir)
        await retainNestedCheckouts(vars, checkouts, retainedDir, repoRealpath);
      await slotDeletePath(vars, source.absolute);
    }
    return { directory, roots: sources.length };
  } finally {
    if (!archived) await rm(directory, { recursive: true, force: true });
    await slotDeletePath(vars, temporary);
  }
}
