// commands/uninstall.ts — `farmslot uninstall`: remove this installation.
//
// The counterpart to install.sh. Reads persisted state so a custom install
// (FARMSLOT_WORKSPACE/BIN_DIR/HOME) is removed at its real locations. Run history and
// the home dir (gateway auth/profiles) default to KEEP — deleting them is opt-in.
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { Command } from 'commander';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { bold, cyan, dim, green, red } from '../colors.js';
import {
  buildUninstallPlan,
  type Disposition,
  executeUninstallPlan,
  type UninstallPlan,
} from '../onboarding/uninstall.js';
import { readState, resolveWorkspace, type WorkspaceState } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

interface UninstallFlags {
  dryRun?: boolean;
  yes?: boolean;
  purge?: boolean;
  keepHistory?: boolean;
  deleteHistory?: boolean;
  backupHistory?: string;
  keepHome?: boolean;
  deleteHome?: boolean;
  backupHome?: string;
  force?: boolean;
}

interface Resolved {
  disposition: Disposition;
  backupPath?: string;
}

/** Turn keep/delete/backup flags for one target into a disposition, or null if none set. */
function fromFlags(
  keep: boolean | undefined,
  del: boolean | undefined,
  backup: string | undefined,
): Resolved | null {
  const set = [keep, del, backup].filter(Boolean).length;
  if (set === 0) return null;
  if (set > 1) throw new Error('choose only one of keep / delete / backup for the same target');
  if (keep) return { disposition: 'keep' };
  if (del) return { disposition: 'delete' };
  return { disposition: 'backup', backupPath: backup };
}

function countEntries(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function defaultBackupPath(label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(homedir(), `farmslot-${label}-backup-${stamp}.tgz`);
}

async function askDisposition(
  rl: ReturnType<typeof createInterface>,
  label: string,
  detail: string,
  backupLabel: string,
): Promise<Resolved> {
  const ans = (await rl.question(`  ${label} ${dim(detail)} — [k]eep / [b]ackup / [d]elete? [k] `))
    .trim()
    .toLowerCase();
  if (ans.startsWith('d')) return { disposition: 'delete' };
  if (ans.startsWith('b')) {
    const def = defaultBackupPath(backupLabel);
    const path = (await rl.question(`    archive path [${def}]: `)).trim();
    return { disposition: 'backup', backupPath: path || def };
  }
  return { disposition: 'keep' };
}

function printPlan(output: OutputContext, plan: UninstallPlan): void {
  const dispo = (d: Disposition, backup?: string): string =>
    d === 'keep'
      ? green('keep')
      : d === 'delete'
        ? red('delete')
        : `${cyan('backup')} ${dim(`-> ${backup}`)}`;
  output.write(`\n${bold('farmslot uninstall plan')}${plan.dryRun ? dim('  (dry run)') : ''}\n`);
  output.write(`  workspace   ${dim(plan.workspaceRoot)}\n`);
  for (const dir of plan.installDirs) output.write(`  ${red('remove')}      ${dir}\n`);
  output.write(`  ${red('remove')}      ${plan.installFiles.join(', ')}\n`);
  output.write(
    `  symlink     ${plan.symlink ? `${red('remove')} ${plan.symlink}` : dim('none owned by this workspace')}\n`,
  );
  output.write(
    `  run history ${dispo(plan.history, plan.historyBackupPath)} ${dim(plan.runsDir)}\n`,
  );
  output.write(`  home/auth   ${dispo(plan.home, plan.homeBackupPath)} ${dim(plan.homeDir)}\n\n`);
}

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Remove this farmslot installation (workspace + CLI symlink; history/home opt-in)')
    .option('--dry-run', 'show what would be removed, change nothing')
    .option('-y, --yes', 'do not prompt; keep run history + home/credentials unless --purge')
    .option('--purge', 'also delete run history and home/credentials (implies --yes)')
    .option('--keep-history', 'keep <workspace>/runs')
    .option('--delete-history', 'delete <workspace>/runs')
    .option('--backup-history <path>', 'archive <workspace>/runs to <path>, then remove it')
    .option('--keep-home', 'keep the farmslot home dir (gateway auth/profiles/logs)')
    .option('--delete-home', 'delete the farmslot home dir')
    .option('--backup-home <path>', 'archive the home dir to <path>, then remove it')
    .option(
      '--force',
      'proceed even without a readable state.json (removes the workspace only; home always kept)',
    )
    .action(async (flags: UninstallFlags, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const ws = resolveWorkspace();
      if (!ws) {
        output.error('no farmslot workspace found — nothing to uninstall');
        process.exit(1);
      }
      let state: WorkspaceState | null = null;
      try {
        state = readState(ws);
      } catch {
        // Corrupt/absent state: still remove the workspace, but a readable state is the only
        // proof the fallback home dir belongs to THIS install — so it is force-kept below.
        output.write(
          dim('  (no readable state.json — keeping the home dir and skipping symlink)\n'),
        );
      }

      // A readable state.json is the proof this is a farmslot workspace we own. Without it a
      // wrong FARMSLOT_WORKSPACE could point at unrelated dirs — refuse unless explicitly forced.
      if (state === null && !flags.force) {
        output.error(
          'no readable state.json — refusing to remove install dirs without proof they belong to farmslot; re-run install.sh to repair, or pass --force (workspace only; the home dir is always kept without state)',
        );
        process.exit(1);
      }

      const purge = Boolean(flags.purge);
      const assumeYes = purge || Boolean(flags.yes);
      const isTTY = Boolean(process.stdin.isTTY);
      const interactive = isTTY && !assumeYes;

      let history: Resolved;
      let home: Resolved;
      try {
        history =
          fromFlags(flags.keepHistory, flags.deleteHistory, flags.backupHistory) ??
          (purge ? { disposition: 'delete' } : { disposition: 'keep' });
        home =
          fromFlags(flags.keepHome, flags.deleteHome, flags.backupHome) ??
          (purge ? { disposition: 'delete' } : { disposition: 'keep' });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Interactive: let the user decide per target (only where not pinned by a flag).
      if (interactive) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          if (fromFlags(flags.keepHistory, flags.deleteHistory, flags.backupHistory) === null) {
            const n = countEntries(ws.runsDir);
            history = await askDisposition(rl, 'Run history', `(${n} archived)`, 'runs');
          }
          if (
            state !== null &&
            fromFlags(flags.keepHome, flags.deleteHome, flags.backupHome) === null
          ) {
            const dir = state.home_dir ?? farmslotHome();
            home = await askDisposition(rl, 'Home / credentials', dir, 'home');
          }
        } finally {
          rl.close();
        }
      }

      // A readable state is the only proof the fallback home belongs to this install — so
      // never delete/back it up without one, even under --purge/--delete-home.
      if (state === null && home.disposition !== 'keep') {
        output.write(dim('  keeping home (no state.json to confirm it belongs to this install)\n'));
        home = { disposition: 'keep' };
      }

      let plan: UninstallPlan;
      try {
        plan = buildUninstallPlan(ws, state, {
          history: history.disposition,
          home: home.disposition,
          historyBackupPath: history.backupPath,
          homeBackupPath: home.backupPath,
          dryRun: Boolean(flags.dryRun),
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      if (!output.json) printPlan(output, plan);

      if (plan.dryRun) {
        if (output.json) output.writeJson({ plan, dryRun: true });
        else output.write(dim('dry run — nothing was removed\n'));
        return;
      }

      // Consent gate: never destroy without explicit confirmation. A non-interactive
      // run (no TTY, or piped stdin) must pass --yes/--purge; otherwise refuse.
      if (!assumeYes) {
        if (!isTTY) {
          output.error(
            'refusing to uninstall non-interactively without --yes (preview with --dry-run)',
          );
          process.exit(1);
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const ok = (await rl.question(`${red('Proceed with uninstall?')} [y/N] `))
            .trim()
            .toLowerCase();
          if (ok !== 'y' && ok !== 'yes') {
            output.write('cancelled\n');
            return;
          }
        } finally {
          rl.close();
        }
      }

      const steps: string[] = [];
      executeUninstallPlan(plan, {
        step: (label) => {
          steps.push(label);
          if (!output.json) output.write(`${green('[OK]')} ${label}\n`);
        },
      });
      if (output.json) output.writeJson({ plan, status: 'removed', steps });
      else output.write(`\n${green('farmslot uninstalled')}\n`);
    });
}
