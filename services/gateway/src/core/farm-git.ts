import { shSingleQuote } from '../../../../scripts/lib/shell-quote.mjs';

/** Command-scoped policy for farm operations, including Git spawned by scripts. */
export function withFarmGitConfig(command: string): string {
  // Append rather than replace inherited -c settings. Parameters take precedence
  // over repo/global config and GIT_CONFIG_COUNT, without writing any config file.
  const config = shSingleQuote("'gc.auto=0' 'maintenance.auto=false'");
  return `(export GIT_CONFIG_PARAMETERS="\${GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }"${config}\n${command}\n)`;
}
