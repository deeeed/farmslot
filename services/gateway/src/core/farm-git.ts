import { shSingleQuote } from '../../../../scripts/lib/shell-quote.mjs';

const keepaliveOptions = '-o ServerAliveInterval=20 -o ServerAliveCountMax=30';

// Git invokes this in its repository cwd, including when the caller uses -C.
// Resolve core.sshCommand there, preserving Git's env > config > GIT_SSH precedence.
const configuredSsh = `
  eval "$FARMSLOT_GIT_SSH_CONFIG"
  command=$(git config --get core.sshCommand)
  status=$?
  if [ "$status" -gt 1 ]; then exit "$status"; fi
  if [ -n "$command" ]; then
    eval "exec $command ${keepaliveOptions}" ' "$@"'
  else
    exec "\${GIT_SSH:-ssh}" ${keepaliveOptions} "$@"
  fi
`;

/** Wrap only farm-owned Git payloads, never tmux clients or worker launches. */
export function withFarmGitConfig(command: string): string {
  // Append rather than replace inherited -c settings. Parameters take precedence
  // over repo/global config and GIT_CONFIG_COUNT, without writing any config file.
  const config = shSingleQuote("'gc.auto=0' 'maintenance.auto=false'");
  return `(export GIT_CONFIG_PARAMETERS="\${GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }"${config}
if [ -n "\${GIT_SSH_COMMAND:-}" ]; then
  export GIT_SSH_COMMAND="$GIT_SSH_COMMAND ${keepaliveOptions}"
else
  # Git clears GIT_CONFIG_* before invoking SSH. Retain the inherited config
  # for the local adapter's lookup, with Bash quoting preserving all values.
  export FARMSLOT_GIT_SSH_CONFIG=$(
    for name in \${!GIT_CONFIG_@}; do printf 'export %s=%q\\n' "$name" "\${!name}"; done
  )
  export GIT_SSH_COMMAND=${shSingleQuote(`bash -c ${shSingleQuote(configuredSsh)} farm-git-ssh`)}
fi
${command}
)`;
}

/** Preserve argv boundaries for Git RPCs and their script subprocesses. */
export function withFarmGitArgv(argv: string[]): string[] {
  return ['bash', '-c', withFarmGitConfig('exec "$@"'), 'farm-git', ...argv];
}
