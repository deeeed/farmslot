import {
  type FarmRole,
  farmPathEntries,
  resolveReportedFarmPaths,
} from '@farmslot/protocol/node/farm-paths';
import { type Command, Option } from 'commander';

import { OutputContext } from '../output.js';

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
}
