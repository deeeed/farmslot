import { existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';

import { dim, green } from '../colors.js';
import { generatePool, poolFileName, writePool } from '../onboarding/pool-config.js';
import { commandPath, detectRunners } from '../onboarding/prereqs.js';
import {
  readState,
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
  binDir?: string;
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
    .option('--bin-dir <path>', 'directory holding the farmslot PATH symlink')
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

      let existing;
      try {
        existing = readState(ws);
      } catch (err) {
        output.error(
          `${err instanceof Error ? err.message : String(err)} — fix or remove ${ws.statePath} and re-run install.sh`,
        );
        process.exit(1);
      }
      const host = shortHostname();
      // In dev/test mode the source checkout may already own pool/<host>.json —
      // never collide with a live machine config.
      const sourcePoolDir = opts.sourceMode === 'local' ? join(opts.source, 'pool') : null;
      const fileName = existing?.pool_file.split('/').pop() ?? poolFileName(host, sourcePoolDir);
      const machine = fileName.replace(/\.json$/, '');
      const poolRelPath = `pool/${fileName}`;
      const poolAbsPath = join(ws.farmslotDir, poolRelPath);

      let poolCreated = false;
      if (!existsSync(poolAbsPath)) {
        mkdirSync(join(ws.farmslotDir, 'pool'), { recursive: true });
        const pool = generatePool({
          machine,
          os: process.platform === 'darwin' ? 'darwin' : 'linux',
          sshUser: process.env.USER ?? 'farmslot',
          runnerPaths: {
            claude: runnerPath('claude'),
            codex: runnerPath('codex'),
            cursor: runnerPath('cursor-agent'),
            grok: runnerPath('grok'),
          },
        });
        writePool(poolAbsPath, pool);
        poolCreated = true;
      }
      if (!output.json) {
        output.write(
          poolCreated
            ? `${green('created')} ${poolRelPath} ${dim(`(machine ${machine})`)}\n`
            : `${dim('exists')} ${poolRelPath} — left untouched\n`,
        );
      }

      const state: WorkspaceState = {
        schema_version: existing?.schema_version ?? 1,
        source:
          opts.sourceMode === 'local'
            ? { mode: 'local', path: opts.source }
            : { mode: 'git', url: opts.source },
        machine,
        pool_file: poolRelPath,
        bin_dir: opts.binDir ?? existing?.bin_dir,
        packs: existing?.packs ?? {},
        pool_migrations: existing?.pool_migrations ?? { applied: [] },
      };
      writeState(ws, state);

      const runners = detectRunners().filter((r) => r.status === 'authenticated');
      if (output.json) {
        output.writeJson({
          workspace: ws.root,
          machine,
          pool_file: poolRelPath,
          pool_created: poolCreated,
          authenticated_runners: runners.map((r) => r.name),
        });
      } else {
        output.write(`${green('workspace ready')} ${dim(ws.root)}\n`);
      }
      if (runners.length === 0) {
        output.error(
          'no authenticated agent runner found (sign in to one of: claude, codex, cursor-agent, grok)',
        );
        process.exit(1);
      }
    });
}
