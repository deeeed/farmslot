const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

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

function canResumeGrokProfileContext(previous, current, ambientHome) {
  if (
    !current.profileId ||
    !current.profileAccountContextId ||
    previous.home !== ambientHome ||
    current.home !== current.profileDirectory ||
    current.grokHome !== current.profileDirectory
  )
    return false;
  const keys = Object.keys(previous);
  return (
    keys.length === Object.keys(current).length &&
    keys.every((key) => key === 'home' || previous[key] === current[key])
  );
}

// Grok loads a checkout's hooks, agents, MCP and LSP servers, instructions and skills only once the
// folder is trusted, and a grant covers the folder's subdirectories. So a review checkout is refused
// when the trust store names it or any parent, in any form, or when folder trust is switched off.
function grokTrustAdmitsCheckout(cwd, env) {
  const grokHome = env.GROK_HOME || join(env.HOME || homedir(), '.grok');
  if (env.GROK_FOLDER_TRUST !== undefined) return true;
  const read = (file) => {
    try {
      return readFileSync(join(grokHome, file), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  };
  if (read('config.toml').includes('folder_trust')) return true;
  const store = read('trusted_folders.toml');
  const folders = new Set();
  for (const start of [resolve(cwd), ...(existsSync(cwd) ? [realpathSync(cwd)] : [])])
    for (let folder = start; ; folder = dirname(folder)) {
      folders.add(folder);
      if (dirname(folder) === folder) break;
    }
  return [...folders].some(
    (folder) => store.includes(JSON.stringify(folder)) || store.includes(`'${folder}'`),
  );
}

function assertGrokReviewAccount(cwd, env, launch = {}) {
  const remedy =
    'Use a GROK_HOME with no hooks, plugins or agents of its own, or set allow_managed_hooks_only = true ' +
    'in its requirements.toml; keep the review checkout and its parents out of its trusted_folders.toml; ' +
    'verify with grok inspect --json; then retry. Use another runner if the account cannot meet this.';
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
  let admitted;
  try {
    admitted = grokTrustAdmitsCheckout(cwd, env);
  } catch {
    throw new Error('Grok review refused: folder trust could not be verified. ' + remedy);
  }
  if (admitted)
    throw new Error(
      'Grok review refused: this account trusts the review checkout or turns folder trust off. ' +
        remedy,
    );
  // Plugin and agent frontmatter hooks load after inspection. The native pin disables them;
  // without it, the account must have no plugins and only built-in agents.
  const pinned =
    Array.isArray(inspection.permissions?.enforced) &&
    inspection.permissions.enforced.some(
      (pin) => pin?.setting === 'nonManagedHooks' && pin.enabled === false,
    );
  if (
    !pinned &&
    (!Array.isArray(inspection.plugins) ||
      inspection.plugins.length > 0 ||
      !Array.isArray(inspection.agents) ||
      inspection.agents.some((agent) => agent?.source?.type !== 'builtin'))
  )
    throw new Error(
      'Grok review refused: account plugins or agents can load hooks and are not disabled by policy. ' +
        remedy,
    );
}

module.exports = { assertGrokReviewAccount, grokProfileEnvironment, canResumeGrokProfileContext };
