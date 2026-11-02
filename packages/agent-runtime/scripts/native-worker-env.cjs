// The one place a native worker's process environment is built. The native host starts workers
// with it, and the gateway's launch preflight runs its probes through this file on the same node,
// so a probe resolves Node and the package manager exactly as the worker will (F318).
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { delimiter, join } = require('node:path');

/** The host's environment without the launch's unset names, plus its set values. */
function nativeWorkerProcessEnvironment(environment, base = process.env) {
  const unset = new Set(environment.unset);
  // Object.fromEntries treats names as data, including names matching Object.prototype keys.
  const env = Object.fromEntries([
    ...Object.entries(base).filter(([key]) => !unset.has(key)),
    ...Object.entries(environment.set),
  ]);
  env.DISABLE_OMC = '1';
  env.DISABLE_OMX = '1';
  // Project-pinned tools win over machine-global installs such as Homebrew's node, as in tmux
  // worker shells (scripts/lib/worker-env-prefix.sh).
  const shims = join(env.ASDF_DATA_DIR ?? join(env.HOME ?? homedir(), '.asdf'), 'shims');
  if (existsSync(shims)) env.PATH = `${shims}${delimiter}${env.PATH ?? ''}`;
  delete env.CLAUDECODE;
  // Workers do not need control-plane credentials, including configured overrides.
  delete env.FARMSLOT_NODE_TOKEN;
  delete env.FARMSLOT_GATEWAY_TOKEN;
  delete env.FARMSLOT_GATEWAY_PASSWORD;
  return env;
}

module.exports = { nativeWorkerProcessEnvironment };

// `node native-worker-env.cjs <environment-json> <command> [args...]` runs the command in that
// environment and exits with its status.
if (require.main === module) {
  const [environment, command, ...args] = process.argv.slice(2);
  const result = spawnSync(command, args, {
    env: nativeWorkerProcessEnvironment(JSON.parse(environment)),
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(127);
  }
  process.exit(result.status ?? 1);
}
