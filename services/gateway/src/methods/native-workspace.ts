import { execFile as execFileCallback } from 'node:child_process';
import { opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  NativeSessionCatalogResult,
  NativeWorkspaceChangesResult,
  NativeWorkspaceListResult,
} from '@farmslot/protocol';

import { loadSlotVars, poolDir } from '../core/config.js';
import { farmslotRoot, isLocal } from '../core/index.js';
import { readWorkspaceText, WORKSPACE_TEXT_LIMIT, workspacePath } from '../core/workspace-files.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { KNOWN_RUNNERS } from '../runners/registry.js';

const execFile = promisify(execFileCallback);

export async function nativeCatalog(): Promise<NativeSessionCatalogResult> {
  const contexts: NativeSessionCatalogResult['contexts'] = [
    { cwd: farmslotRoot, label: 'Farmslot checkout' },
  ];
  for (const pool of await loadPoolConfigs(poolDir)) {
    for (const slot of pool.slots) {
      if (!slot.repo || !isLocal(pool.host, pool.machine)) continue;
      const vars = await loadSlotVars(slot.id);
      if (isLocal(vars.host, vars.machine))
        contexts.push({
          cwd: vars.remoteRepo,
          label: slot.id,
          slotId: slot.id,
          project: vars.projectName,
        });
    }
  }
  return {
    runners: Object.values(KNOWN_RUNNERS).flatMap((definition) =>
      definition.nativeTransport && definition.nativeChoices
        ? [
            {
              runner: definition.id,
              defaultModel: definition.defaultModel ?? '',
              ...definition.nativeChoices,
            },
          ]
        : [],
    ),
    contexts,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(
    'git',
    [
      '--literal-pathspecs',
      '--no-optional-locks',
      '-c',
      'core.quotePath=false',
      '-c',
      'core.fsmonitor=false',
      ...args,
    ],
    {
      cwd,
      maxBuffer: WORKSPACE_TEXT_LIMIT,
      timeout: 15_000,
      // Explicit directory arguments cannot be redirected by inherited Git plumbing variables.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      ),
    },
  );
  return stdout;
}

export async function nativeWorkspaceList(
  cwd: string,
  relative: string,
): Promise<NativeWorkspaceListResult> {
  const directory = await opendir(await workspacePath(cwd, relative));
  const entries: NativeWorkspaceListResult['entries'] = [];
  let truncated = false;
  for await (const entry of directory) {
    if (entry.name.toLowerCase() === '.git' || (!entry.isFile() && !entry.isDirectory())) continue;
    if (entries.length === 500) {
      truncated = true;
      break;
    }
    entries.push({
      path: [relative === '.' ? '' : relative, entry.name].filter(Boolean).join('/'),
      name: entry.name,
      directory: entry.isDirectory(),
    });
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { entries, truncated };
}

export async function nativeWorkspaceChanges(cwd: string): Promise<NativeWorkspaceChangesResult> {
  cwd = await realpath(cwd);
  const raw = await git(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
  ]);
  const repository = (await git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
  const records = raw.split('\0');
  const files: NativeWorkspaceChangesResult['files'] = [];
  for (let i = 0; i < records.length; i++) {
    if (!records[i]) continue;
    const status = records[i].slice(0, 2);
    const file = path.relative(cwd, path.join(repository, records[i].slice(3)));
    if (file === '..' || file.startsWith('../') || path.isAbsolute(file))
      throw new Error('Git returned a path outside the session workspace');
    if (status.includes('R') || status.includes('C')) i++;
    files.push({ path: file, status });
  }
  return { files };
}

export async function nativeWorkspaceDiff(cwd: string, relative: string): Promise<string> {
  await workspacePath(cwd, relative, true);
  const changes = await nativeWorkspaceChanges(cwd);
  const file = changes.files.find((candidate) => candidate.path === relative);
  if (!file) return '';
  if (file.status === '??') {
    const text = await readWorkspaceText(cwd, relative);
    if (!text) return '';
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const name = JSON.stringify(`b/${relative}`);
    return `diff --git ${JSON.stringify(`a/${relative}`)} ${name}\nnew file mode 100644\n--- /dev/null\n+++ ${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join('')}${text.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
  }
  // HEAD shows both staged and unstaged workspace changes. On an unborn branch,
  // staged additions have no HEAD, so use the empty tree produced by Git itself.
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(
    async (error: unknown) => {
      if ((error as { code?: unknown }).code !== 1) throw error;
      return git(cwd, ['hash-object', '-t', 'tree', '/dev/null']);
    },
  );
  return git(cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--relative',
    head.trim(),
    '--',
    relative,
  ]);
}
