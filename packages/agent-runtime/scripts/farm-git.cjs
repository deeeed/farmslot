'use strict';

const { spawn } = require('node:child_process');

const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const PUBLICATION_PUSH_TIMEOUT_MS = 900_000;
const GIT_PUSH_TIMEOUT_SETTING = 'FARMSLOT_GIT_PUSH_TIMEOUT_MS';

function gitPushTimeoutMs(raw) {
  if (raw === undefined) return PUBLICATION_PUSH_TIMEOUT_MS;
  const value = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new Error(
      `${GIT_PUSH_TIMEOUT_SETTING} must be a positive integer in milliseconds, at most 2147483647`,
    );
  return value;
}

class GitPushTimeoutError extends Error {}
function gitPushTimeoutError(timeoutMs) {
  return new GitPushTimeoutError(
    `git push timed out after ${timeoutMs} ms including the repository's pre-push hook budget; increase ${GIT_PUSH_TIMEOUT_SETTING} in project command_env.set or pool env if hooks need more time (hooks were not skipped)`,
  );
}

// Git uses the first shell word's basename for known variants, then probes -G
// for unknown commands. Parse quoting without evaluating the configured command.
function commandVariant(command) {
  let word = '',
    quoted = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (!quoted && /\s/.test(char)) {
      if (word) break;
      else continue;
    }
    if (char === quoted) {
      quoted = '';
      continue;
    }
    if (!quoted && (char === '"' || char === "'")) {
      quoted = char;
      continue;
    }
    if (char === '\\' && quoted !== "'") {
      word += command[++i] ?? '';
      continue;
    }
    word += char;
  }
  const name = word
    .split('/')
    .at(-1)
    .toLowerCase()
    .replace(/\.exe$/, '');
  return ['ssh', 'plink', 'putty', 'tortoiseplink'].includes(name) ? name : 'auto';
}

const transportConfig = `
git() (
  original=("$@")
  config_args=()
  # Git global options must precede the config query, including repeated -C/-c.
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -C|-c|--git-dir|--work-tree|--namespace|--config-env)
        config_args+=("$1" "$2"); shift 2 ;;
      --*=*|--bare|--no-pager|--paginate|--literal-pathspecs|--no-literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-replace-objects)
        config_args+=("$1"); shift ;;
      *) break ;;
    esac
  done
  case "$1" in
    fetch|push|pull|clone|ls-remote|submodule) ;;
    *) command git "\${original[@]}"; exit $? ;;
  esac
  if [ "\${GIT_SSH_COMMAND+x}" = x ]; then
    ssh_command=$GIT_SSH_COMMAND
  else
    if ssh_command=$(command git "\${config_args[@]}" config --get core.sshCommand); then
      :
    else
      ssh_config_status=$?
      if [ "$ssh_config_status" -gt 1 ]; then exit "$ssh_config_status"; fi
      printf -v ssh_command '%q' "\${GIT_SSH:-ssh}"
    fi
  fi
  if [ "\${GIT_SSH_VARIANT+x}" = x ]; then
    variant=$GIT_SSH_VARIANT
  elif variant=$(command git "\${config_args[@]}" config --get ssh.variant); then
    :
  else
    ssh_config_status=$?
    if [ "$ssh_config_status" -gt 1 ]; then exit "$ssh_config_status"; fi
  fi
  variant=$(printf '%s' "$variant" | tr '[:upper:]' '[:lower:]')
  if [ -z "$variant" ] || [ "$variant" = auto ]; then
    variant=$(node -e ${quote(`process.stdout.write((${commandVariant.toString()})(process.argv[1]))`)} "$ssh_command")
    if [ "$variant" = auto ]; then
      if (eval "$ssh_command -G localhost") >/dev/null 2>&1; then variant=ssh; else variant=simple; fi
    fi
  fi
  if [ "$variant" = ssh ]; then
    export GIT_SSH_COMMAND="$ssh_command -o ServerAliveInterval=20 -o ServerAliveCountMax=30"
  fi
  command git "\${original[@]}"
)
`;

/** Keep the caller's subshell and payload intact in both Bash and Darwin zsh. */
function withFarmGitConfig(command) {
  const config = quote("'gc.auto=0' 'maintenance.auto=false'");
  return `(export GIT_CONFIG_PARAMETERS="\${GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }"${config}\n${transportConfig}\n${command}\n)`;
}

function withFarmGitArgv(argv) {
  return [
    'bash',
    '-c',
    withFarmGitConfig('if [ "$1" = git ]; then shift; git "$@"; else exec "$@"; fi'),
    'farm-git',
    ...argv,
  ];
}

module.exports = {
  withFarmGitConfig,
  withFarmGitArgv,
  PUBLICATION_PUSH_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_SETTING,
  gitPushTimeoutMs,
  gitPushTimeoutError,
  GitPushTimeoutError,
};

// A separate supervisor keeps the synchronous runtime API while enforcing a
// deadline on Git and every hook descendant, rather than only killing Git.
if (require.main === module) {
  const timeout = gitPushTimeoutMs(process.env[GIT_PUSH_TIMEOUT_SETTING]);
  const argv = withFarmGitArgv(['git', ...process.argv.slice(2)]);
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'inherit' });
  let timedOut = false;
  function stop() {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      // Git may have exited before its exit event reached the supervisor.
      if (error.code !== 'ESRCH') throw error;
    }
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeout);
  child.on('error', (error) => {
    clearTimeout(timer);
    throw error;
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    process.exitCode = timedOut ? 124 : (code ?? 1);
  });
}
