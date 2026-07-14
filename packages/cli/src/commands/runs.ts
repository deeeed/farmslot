import path from 'node:path';

import { type Command, Option } from 'commander';

import {
  exportRunAsPackage,
  exportRunsToBundle,
  importBundle,
  listBundle,
  resolveFarmslotRoot,
} from '@farmslot/run-bundle';

import { bold, cyan, dim, green } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { OutputContext } from '../output.js';
import { withProgress } from '../progress.js';

import { resolveRunsExportProfile, resolveRunsImportMode } from './runs-cli-options.js';

interface ExportOptions {
  output?: string;
  profile?: 'reference' | 'family' | 'full';
  forensic?: boolean;
  familyId?: string;
  runId?: string[];
  asPackage?: string;
  root?: string;
}

interface ImportOptions {
  readOnly?: boolean;
  keepIds?: boolean;
  mode?: 'reference-only' | 'seed' | 'mirror';
  force?: boolean;
  root?: string;
}

interface PruneOptions {
  status?: string;
  dryRun?: boolean;
  limit?: string;
}

function resolveRootFlag(root: string | undefined): string {
  return resolveFarmslotRoot(process.cwd(), {
    ...process.env,
    ...(root ? { FARMSLOT_ROOT: root } : {}),
  });
}

export function registerRunsCommand(program: Command): void {
  const runs = program
    .command('runs')
    .description('Copy run history between gateways via .farmrun bundles (ADR-039)');

  runs
    .command('export [runId]')
    .description('Save run(s) to a .farmrun bundle')
    .option('-o, --output <path>', 'Output .farmrun path (required)')
    .option('--family-id <id>', 'Export all runs in a family (uses family profile)')
    .option('--run-id <id>', 'Additional run id (repeatable)', collect, [] as string[])
    .option('--forensic', 'Include analytics and debug extras (power users)')
    .option('--as-package <path>', 'Export only the result package JSON for a single run')
    .option('--root <path>', 'Farmslot repo root override (default: auto-detect)')
    .addOption(
      new Option(
        '--profile <profile>',
        'Legacy: reference, family, or full (scripts; prefer defaults and --forensic)',
      ).hideHelp(),
    )
    .action((runId: string | undefined, opts: ExportOptions, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const emit = createEmitter(output, cmd);
      try {
        const farmslotRoot = resolveRootFlag(opts.root);
        if (opts.asPackage) {
          if (!runId) throw new Error('Provide a run id when using --as-package');
          const out = exportRunAsPackage({
            farmslotRoot,
            runId,
            outputPath: path.resolve(opts.asPackage),
          });
          if (emit.machine) emit.ok({ packagePath: out });
          else output.write(`${green('Package exported')} ${cyan(out)}\n`);
          return;
        }
        if (!opts.output) throw new Error('--output is required for bundle export');
        const profile = resolveRunsExportProfile(opts);
        const result = exportRunsToBundle({
          farmslotRoot,
          outputPath: path.resolve(opts.output),
          profile,
          familyId: opts.familyId,
          positionalRunId: runId,
          runIds: opts.runId ?? [],
        });
        if (emit.machine) emit.ok(result);
        else {
          output.write(
            `${green('Bundle exported')} ${bold(String(result.runCount))} run(s) → ${cyan(result.outputPath)}\n`,
          );
          output.write(`  ${dim('bundleId')}   ${result.manifest.bundleId}\n`);
          output.write(`  ${dim('profile')}   ${result.manifest.profile}\n`);
        }
      } catch (err) {
        emit.fail(err);
        return;
      }
    });

  runs
    .command('import <bundlePath>')
    .description('Load a .farmrun bundle (default: writable sandbox copy)')
    .option('--read-only', 'Packages + read-only run stubs; no relaunch or prior-run dispatch')
    .option('--keep-ids', 'Preserve original run IDs (disaster recovery; avoid in worktrees)')
    .option('--force', 'Allow --keep-ids to overwrite conflicting run IDs')
    .option('--root <path>', 'Farmslot repo root override (default: auto-detect)')
    .addOption(
      new Option(
        '--mode <mode>',
        'Legacy: reference-only, seed, or mirror (scripts; prefer default and flags above)',
      ).hideHelp(),
    )
    .action(async (bundlePath: string, opts: ImportOptions, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const farmslotRoot = resolveRootFlag(opts.root);
        const mode = resolveRunsImportMode(opts);
        const useGateway = Boolean(cmd.optsWithGlobals().gateway || cmd.optsWithGlobals().url);
        const label = `Importing ${path.basename(bundlePath)}`;
        let result: ReturnType<typeof importBundle>;
        if (useGateway) {
          result = await withProgress(
            label,
            () =>
              client.call<ReturnType<typeof importBundle>>('run.bundle.import', {
                bundlePath: path.resolve(bundlePath),
                mode,
                force: opts.force || undefined,
              }),
            !emit.machine,
          );
        } else {
          // importBundle is synchronous and blocks the event loop, so the
          // spinner's 80ms interval could never fire. Print an immediate
          // notice before the blocking work instead.
          const showNotice = !emit.machine && (process.stderr.isTTY ?? false);
          if (showNotice) process.stderr.write(`${label}…`);
          try {
            result = importBundle({
              farmslotRoot,
              bundlePath: path.resolve(bundlePath),
              mode,
              force: opts.force,
            });
          } finally {
            if (showNotice) process.stderr.write('\r\x1b[K');
          }
        }
        if (emit.machine) emit.ok(result);
        else {
          output.write(
            `${green('Bundle imported')} ${bold(String(result.importedRunIds.length))} run(s) · ${dim(mode)}\n`,
          );
          for (const id of result.importedRunIds) {
            output.write(`  ${cyan(id)}\n`);
          }
          if (result.packagePaths.length) {
            output.write(`  ${dim('packages')} ${result.packagePaths.join(', ')}\n`);
          }
          if (!useGateway) {
            output.write(
              `  ${dim('tip')} use --gateway/--url import to refresh the live run list\n`,
            );
          }
        }
      } catch (err) {
        emit.fail(err);
        return;
      }
    });

  runs
    .command('prune')
    .description('Bulk-delete terminal runs matching status filters')
    .option(
      '--status <list>',
      'Comma-separated statuses (default failed,cancelled)',
      'failed,cancelled',
    )
    .option('--dry-run', 'List matching runs without deleting')
    .option('--limit <n>', 'Max runs to delete (default 200)', '200')
    .action(async (opts: PruneOptions, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        const statuses = new Set(
          (opts.status ?? 'failed,cancelled')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        const limit = Math.max(1, Number(opts.limit ?? 200) || 200);
        const listed = await withProgress(
          'Scanning runs',
          () =>
            client.call<{ runs: Array<{ id: string; status: string }> }>('run.list', {
              limit: 1000,
            }),
          !emit.machine,
        );
        const targets = listed.runs
          .filter((run) => statuses.has(run.status))
          .slice(0, limit)
          .map((run) => run.id);
        if (opts.dryRun) {
          if (emit.machine) emit.ok({ dryRun: true, runIds: targets });
          else {
            output.write(`Would delete ${targets.length} run(s)\n`);
            for (const id of targets) output.write(`  ${id}\n`);
          }
          return;
        }
        const deleted = await withProgress(
          `Deleting ${targets.length} run(s)`,
          async () => {
            let count = 0;
            for (const runId of targets) {
              await client.call('run.delete', { runId });
              count++;
            }
            return count;
          },
          !emit.machine,
        );
        if (emit.machine) emit.ok({ deleted, runIds: targets });
        else output.write(`${green('Deleted')} ${bold(String(deleted))} run(s)\n`);
      } catch (err) {
        emit.fail(err);
        return;
      }
    });

  const bundle = runs.command('bundle').description('Inspect portable run bundles');
  bundle
    .command('ls <bundlePath>')
    .description('List manifest summary for a .farmrun bundle')
    .action((bundlePath: string, _opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const emit = createEmitter(output, cmd);
      try {
        const manifest = listBundle(path.resolve(bundlePath));
        if (emit.machine) emit.ok({ manifest });
        else {
          output.write(`${bold(manifest.bundleId)} ${dim(manifest.exportedAt)}\n`);
          output.write(
            `  ${dim('profile')} ${manifest.profile} · ${manifest.runs.length} run(s)\n`,
          );
          output.write(`  ${dim('source')} ${manifest.source.farmslotRoot}\n`);
          for (const run of manifest.runs) {
            output.write(
              `  - ${run.originalRunId}${run.taskKey ? ` · task ${run.taskKey}` : ''}\n`,
            );
          }
        }
      } catch (err) {
        emit.fail(err);
        return;
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
