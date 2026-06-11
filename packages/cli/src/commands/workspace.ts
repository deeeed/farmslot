import { existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';

import { dim, green } from '../colors.js';
import { generatePool, poolFileName, writePool } from '../onboarding/pool-config.js';
import { commandPath, detectRunners } from '../onboarding/prereqs.js';
import {
  readState,
  repoRoot,
  resolveWorkspace,
  type WorkspaceState,
  writeState,
} from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

function shortHostname(): string {
  return hostname().split('.')[0].toLowerCase();
}

function runnerPath(name: string): string | undefined {
  return commandPath(name) ?? undefined;
}

interface WorkspaceInitOptions {
  sourceMode: 'local' | 'git';
  source: string;
}

export function registerWorkspaceCommand(program: Command): void {
  const workspace = program
    .command('workspace')
    .description('Workspace layout management (used by install.sh)');

  workspace
    .command('init')
    .description('Initialize workspace dirs, state.json, and the machine pool file (idempotent)')
    .requiredOption('--source-mode <mode>', "install source: 'local' checkout or 'git' URL")
    .requiredOption(
      '--source <pathOrUrl>',
      'local checkout path or git URL farmslot was installed from',
    )
    .action((opts: WorkspaceInitOptions, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      if (opts.sourceMode !== 'local' && opts.sourceMode !== 'git') {
        output.error(`--source-mode must be 'local' or 'git', got '${opts.sourceMode}'`);
        process.exit(1);
      }
      const ws = resolveWorkspace();
      if (!ws) {
        output.error('FARMSLOT_WORKSPACE is not set — workspace init is run by install.sh');
        process.exit(1);
      }

      for (const dir of [ws.root, ws.reposDir, ws.runsDir]) mkdirSync(dir, { recursive: true });

      const existing = readState(ws);
      const host = shortHostname();
      // In dev/test mode the source checkout may already own pool/<host>.json —
      // never collide with a live machine config.
      const sourcePoolDir = opts.sourceMode === 'local' ? join(opts.source, 'pool') : null;
      const fileName = existing?.pool_file.split('/').pop() ?? poolFileName(host, sourcePoolDir);
      const machine = fileName.replace(/\.json$/, '');
      const poolRelPath = `pool/${fileName}`;
      const poolAbsPath = join(repoRoot, poolRelPath);

      if (!existsSync(poolAbsPath)) {
        mkdirSync(join(repoRoot, 'pool'), { recursive: true });
        const pool = generatePool({
          machine,
          os: process.platform === 'darwin' ? 'darwin' : 'linux',
          sshUser: process.env.USER ?? 'farmslot',
          runnerPaths: {
            claude: runnerPath('claude'),
            codex: runnerPath('codex'),
            cursor: runnerPath('cursor-agent'),
          },
        });
        writePool(poolAbsPath, pool);
        output.write(`${green('created')} ${poolRelPath} ${dim(`(machine ${machine})`)}\n`);
      } else {
        output.write(`${dim('exists')} ${poolRelPath} — left untouched\n`);
      }

      const state: WorkspaceState = {
        schema_version: existing?.schema_version ?? 1,
        source:
          opts.sourceMode === 'local'
            ? { mode: 'local', path: opts.source }
            : { mode: 'git', url: opts.source },
        machine,
        pool_file: poolRelPath,
        packs: existing?.packs ?? {},
        pool_migrations: existing?.pool_migrations ?? { applied: [] },
      };
      writeState(ws, state);
      output.write(`${green('workspace ready')} ${dim(ws.root)}\n`);

      const runners = detectRunners().filter((r) => r.found);
      if (runners.length === 0) {
        output.error('no agent runner found on PATH (claude, codex, or cursor-agent required)');
        process.exit(1);
      }
    });
}
