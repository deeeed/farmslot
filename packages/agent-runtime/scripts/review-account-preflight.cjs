const { execFileSync } = require('node:child_process');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

function grokProfileEnvironment(directory, base = process.env) {
  const home = homeDirectory(base);
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

const homeDirectory = (env) => env.HOME || homedir();
/** Where Grok reads its login and settings when no profile selects another directory. */
const grokHome = (env) => env.GROK_HOME || join(homeDirectory(env), '.grok');

function readGrokHomeFile(env, file) {
  try {
    return readFileSync(join(grokHome(env), file), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

// A grant covers the folder's subdirectories, so the store must name neither the checkout nor any
// parent, in either TOML string form.
function grokTrustStoreNamesCheckout(cwd, env) {
  const store = readGrokHomeFile(env, 'trusted_folders.toml');
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
    'Use a GROK_HOME with no hooks, MCP or LSP servers, plugins, agents or notification commands of its own, or set ' +
    'allow_managed_hooks_only = true in its requirements.toml; keep folder trust on, and the review ' +
    'checkout and its parents out of its trusted_folders.toml; verify with grok inspect --json; then ' +
    'retry. Use another runner if the account cannot meet this.';
  const executable = launch.executable || 'grok';
  const inspect = (directory) => {
    const args = ['--no-leader', '--no-auto-update', '--cwd', directory, 'inspect', '--json'];
    return JSON.parse(
      execFileSync(
        launch.processSandbox?.executable || executable,
        launch.processSandbox ? [...launch.processSandbox.args, executable, ...args] : args,
        { cwd: directory, env, encoding: 'utf8', stdio: 'pipe', timeout: 10000 },
      ),
    );
  };
  // Grok lists the account's own hooks only from a folder it trusts for them. The home directory
  // is one, and Grok loads no project configuration there.
  let inspection;
  try {
    inspection = inspect(homeDirectory(env));
  } catch {
    // Inspector output can include account secrets. Refuse without echoing stdout/stderr.
    throw new Error('Grok review refused: account hook safety could not be verified. ' + remedy);
  }
  if (
    !inspection ||
    typeof inspection.grokVersion !== 'string' ||
    inspection.projectTrusted !== true ||
    !Array.isArray(inspection.hooks) ||
    !Array.isArray(inspection.mcpServers) ||
    !Array.isArray(inspection.lspServers) ||
    (inspection.hookLoadErrors !== undefined &&
      (!Array.isArray(inspection.hookLoadErrors) || inspection.hookLoadErrors.length > 0))
  )
    throw new Error('Grok review refused: account hook safety could not be verified. ' + remedy);
  // Do not classify commands as safe: a global hook can invoke any PR-supplied file.
  if (inspection.hooks.some((hook) => hook?.disabled !== true))
    throw new Error('Grok review refused: this account has startup hooks enabled. ' + remedy);
  // An account's MCP or LSP server is a command too, and the hook pin does not cover it.
  if (inspection.mcpServers.length > 0 || inspection.lspServers.length > 0)
    throw new Error(
      'Grok review refused: this account starts its own MCP or LSP servers. ' + remedy,
    );
  // Grok loads a checkout's hooks, agents, MCP and LSP servers, instructions and skills only once
  // the folder is trusted, so the review checkout must stay untrusted.
  let named;
  try {
    named = grokTrustStoreNamesCheckout(cwd, env);
  } catch {
    throw new Error('Grok review refused: folder trust could not be verified. ' + remedy);
  }
  if (named)
    throw new Error(
      'Grok review refused: this account trusts the review checkout or one of its parents. ' +
        remedy,
    );
  // The environment, any config layer, device management or remote settings can switch folder
  // trust off. Ask Grok: a fresh folder holding only project instructions must read as untrusted.
  let gated;
  let probe;
  try {
    probe = mkdtempSync(join(launch.inspectionCwd || tmpdir(), 'grok-trust-probe-'));
    writeFileSync(join(probe, 'AGENTS.md'), 'Folder-trust probe.\n');
    const result = inspect(probe);
    gated =
      result?.projectTrusted === false &&
      Array.isArray(result.projectInstructions) &&
      result.projectInstructions.length === 0;
  } catch {
    throw new Error('Grok review refused: folder trust could not be verified. ' + remedy);
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
  if (!gated)
    throw new Error('Grok review refused: folder trust is off for this account. ' + remedy);
  // Plugin hooks, agent frontmatter hooks and notification commands load after inspection. The
  // native pin disables them; without it, the account must have none.
  const pinned =
    Array.isArray(inspection.permissions?.enforced) &&
    inspection.permissions.enforced.some(
      (pin) => pin?.setting === 'nonManagedHooks' && pin.enabled === false,
    );
  if (pinned) return;
  let notifications;
  try {
    notifications = readGrokHomeFile(env, 'config.toml')
      .split('\n')
      .some((line) => !line.trim().startsWith('#') && line.includes('notifications'));
  } catch {
    throw new Error('Grok review refused: account hook safety could not be verified. ' + remedy);
  }
  if (
    !Array.isArray(inspection.plugins) ||
    inspection.plugins.length > 0 ||
    !Array.isArray(inspection.agents) ||
    inspection.agents.some((agent) => agent?.source?.type !== 'builtin') ||
    notifications
  )
    throw new Error(
      'Grok review refused: account plugins, agents or notification commands can run and are not disabled by policy. ' +
        remedy,
    );
}

module.exports = {
  assertGrokReviewAccount,
  grokHome,
  grokProfileEnvironment,
  canResumeGrokProfileContext,
  homeDirectory,
};
