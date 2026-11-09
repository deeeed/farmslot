import { type Command, Option } from 'commander';

import {
  farmPathEntries,
  type FarmRole,
  resolveReportedFarmPaths,
} from '@farmslot/protocol/node/farm-paths';

import { OutputContext } from '../output.js';

import { migratePaths } from './paths-migrate.js';

interface PathsOptions {
  home?: string;
  role: FarmRole;
  json?: boolean;
}

function report(cmd: Command, key?: string): void {
  const opts = cmd.optsWithGlobals<PathsOptions>();
  const output = new OutputContext(opts.json ?? false);
  const paths = resolveReportedFarmPaths({ home: opts.home, role: opts.role });
  const entries = farmPathEntries(paths);
  const entry = key === undefined ? undefined : entries.find(([name]) => name === key);
  if (key !== undefined && !entry) throw new Error(`Unknown farm path key: ${key}`);
  if (output.json) output.writeJson(entry ? entry[1] : paths);
  else
    output.write(
      entry ? `${entry[1]}\n` : entries.map(([name, value]) => `${name}\t${value}\n`).join(''),
    );
}

export function registerPathsCommand(program: Command): void {
  const paths = program
    .command('paths')
    .description("Report this instance's farm paths without changing files")
    .option('--home <dir>', 'Farm instance home (default: FARMSLOT_HOME or ~/.farmslot)')
    .addOption(
      new Option('--role <role>', 'Farm role').choices(['gateway', 'node']).default('gateway'),
    )
    .action((_opts: PathsOptions, cmd: Command) => report(cmd));

  paths
    .command('get <key>')
    .description('Report one path by dot key, such as data.runBundles')
    .action((key: string, _opts: PathsOptions, cmd: Command) => report(cmd, key));
  paths
    .command('migrate')
    .description('Move one stopped legacy instance to layout 2, or resume/roll back its journal')
    .option('--home <dir>', 'Existing legacy instance home (required)')
    .option('--data <dir>', 'Data root (default: FARMSLOT_DATA or <home>/data)')
    .option('--plan', 'List moves, rewrites, retained paths and conflicts without writing')
    .option('--apply', 'Apply or resume the migration journal')
    .option('--rollback', 'Replay the latest migration journal backwards')
    .option('--json', 'Print the migration journal as JSON')
    .action(async (_opts: MigrateOptions, command: Command) => {
      const opts = command.optsWithGlobals<MigrateOptions>();
      if ([opts.plan, opts.apply, opts.rollback].filter(Boolean).length !== 1)
        throw new Error('Select exactly one of --plan, --apply or --rollback');
      if (!opts.home?.trim()) throw new Error('--home must be nonempty');
      const result = await migratePaths(
        { home: opts.home, data: opts.data },
        opts.plan ? 'plan' : opts.apply ? 'apply' : 'rollback',
      );
      const output = new OutputContext(opts.json ?? false);
      if (output.json)
        output.writeJson({
          ...result,
          steps: result.steps.map((step) => {
            if (step.kind === 'move') {
              const { expected: _expected, ...summary } = step;
              return summary;
            }
            const { before: _before, body: _body, ...summary } = step;
            return summary;
          }),
        });
      else {
        output.write(`Migration ${result.status}: ${result.journal}\n`);
        for (const step of result.steps) {
          if (step.kind === 'move')
            output.write(
              `${step.source} -> ${step.target}\t${step.bytes} bytes\t${step.method === 'rename' ? 'same-volume rename' : 'cross-volume copy + sha256 verify'}\n`,
            );
          else {
            output.write(`write ${step.target}\n`);
            for (const entry of step.rewrites)
              output.write(`  ${entry.source} -> ${entry.target}\n`);
          }
        }
        for (const entry of result.stays) output.write(`stays ${entry.path}: ${entry.reason}\n`);
        for (const conflict of result.conflicts) output.write(`conflict ${conflict}\n`);
      }
    });
}

interface MigrateOptions extends PathsOptions {
  data?: string;
  plan?: boolean;
  apply?: boolean;
  rollback?: boolean;
}
