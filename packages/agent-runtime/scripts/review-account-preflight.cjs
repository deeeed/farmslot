const { execFileSync } = require('node:child_process');
const { existsSync, realpathSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');

function grokProfileEnvironment(directory, base = process.env) {
  const home = base.HOME || homedir();
  const defaultDirectory = join(home, '.grok');
  const canonicalDefault = existsSync(defaultDirectory)
    ? realpathSync(defaultDirectory)
    : resolve(defaultDirectory);
  return {
    GROK_HOME: directory,
    ...(directory === canonicalDefault
      ? {}
      : {
          HOME: directory,
          GIT_CONFIG_GLOBAL: base.GIT_CONFIG_GLOBAL || join(home, '.gitconfig'),
        }),
  };
}

function assertGrokReviewAccount(cwd, env, launch = {}) {
  const remedy =
    'Set allow_managed_hooks_only = true in the selected GROK_HOME/requirements.toml, ' +
    'disable or remove native, plugin and compatibility hooks, and verify grok inspect --json ' +
    'reports nonManagedHooks disabled and every hook disabled; then retry. Use another runner if enforced hooks cannot be disabled.';
  const executable = launch.executable || 'grok';
  // Account discovery must not confuse intentionally masked PR configuration with unreadable account hooks.
  const inspectionCwd = launch.inspectionCwd || cwd;
  const args = ['--no-leader', '--no-auto-update', '--cwd', inspectionCwd, 'inspect', '--json'];
  let inspection;
  try {
    inspection = JSON.parse(
      execFileSync(
        launch.processSandbox?.executable || executable,
        launch.processSandbox ? [...launch.processSandbox.args, executable, ...args] : args,
        { cwd: inspectionCwd, env, encoding: 'utf8', stdio: 'pipe', timeout: 10000 },
      ),
    );
  } catch {
    // Inspector output can include account secrets. Refuse without echoing stdout/stderr.
    throw new Error('Grok review refused: account hook safety could not be verified. ' + remedy);
  }
  if (
    !inspection ||
    typeof inspection.grokVersion !== 'string' ||
    !Array.isArray(inspection.hooks) ||
    (inspection.hookLoadErrors !== undefined &&
      (!Array.isArray(inspection.hookLoadErrors) || inspection.hookLoadErrors.length > 0))
  )
    throw new Error('Grok review refused: account hook safety could not be verified. ' + remedy);
  // Do not classify commands as safe: a global hook can invoke any PR-supplied file.
  if (inspection.hooks.some((hook) => hook?.disabled !== true))
    throw new Error('Grok review refused: this account has startup hooks enabled. ' + remedy);
  // The native pin also covers agent/frontmatter and notification hooks loaded after inspection.
  if (
    !Array.isArray(inspection.permissions?.enforced) ||
    !inspection.permissions.enforced.some(
      (pin) => pin?.setting === 'nonManagedHooks' && pin.enabled === false,
    )
  )
    throw new Error(
      'Grok review refused: account startup hooks are not disabled by policy. ' + remedy,
    );
}

module.exports = { assertGrokReviewAccount, grokProfileEnvironment };
