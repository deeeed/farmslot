// Runner-native trust stores. Callers admit only farm-created worker workspaces.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  assertGrokReviewAccount,
  grokHome,
  homeDirectory: home,
} = require('./review-account-preflight.cjs');
const { tomlSectionHeaderIndexes, tomlBareStringValue } = require('./toml-scan.cjs');

const lockScript = String.raw`
import fcntl, os, subprocess, sys
with os.fdopen(os.open(sys.argv[1] + '.farmslot-review.lock', os.O_CREAT | os.O_RDWR, 0o600), 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    subprocess.run(sys.argv[2:], check=True, timeout=8)
`;
const escapeToml = (value) => JSON.stringify(value).slice(1, -1);
const unescapeToml = (value) =>
  value.replace(/\\(u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|.)/g, (match, body, u4, u8) => {
    if (u4 || u8) return String.fromCodePoint(parseInt(u4 || u8, 16));
    return { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[body] ?? match;
  });

function updateToml(content, namespace, folders, values) {
  const header = new RegExp(
    '^\\s*\\[\\s*' + namespace + '\\s*\\.\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*\\]\\s*(?:#.*)?$',
  );
  const added = [];
  for (const folder of folders) {
    const lines = content.split(/(?<=\n)/);
    const headers = [...tomlSectionHeaderIndexes(lines)];
    const start = headers.find((index) => {
      const match = header.exec(lines[index].trimEnd());
      return match && unescapeToml(match[1]) === folder;
    });
    if (start === undefined) {
      added.push(folder);
      content =
        content.trimEnd() +
        '\n\n[' +
        namespace +
        '."' +
        escapeToml(folder) +
        '"]\n' +
        Object.entries(values)
          .map(([key, value]) => key + ' = ' + JSON.stringify(value) + '\n')
          .join('');
      continue;
    }
    const end = headers.find((index) => index > start) ?? lines.length;
    const record = lines.slice(start, end);
    for (const [key, value] of Object.entries(values)) {
      const assignment = new RegExp('^\\s*' + key + '\\s*=');
      const index = record.findIndex((line) => assignment.test(line));
      // Grok's original decision timestamp stays stable across launch/replay.
      if (
        index >= 0 &&
        (key === 'decided_at' || tomlBareStringValue(record[index], key) === String(value))
      )
        continue;
      const next = key + ' = ' + JSON.stringify(value) + '\n';
      if (index >= 0) record[index] = next;
      else record.splice(1, 0, next);
    }
    content = lines.slice(0, start).concat(record, lines.slice(end)).join('');
  }
  return { content: content.replace(/^\n+/, ''), added };
}

function writeTrust(file, request) {
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let next;
  let added = [];
  if (request.namespace) {
    const result = updateToml(content, request.namespace, request.folders, request.values);
    next = result.content;
    added = result.added;
  } else {
    let data;
    try {
      data = content ? JSON.parse(content) : {};
    } catch {
      throw new Error('Invalid runner configuration JSON');
    }
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      (data.projects && (typeof data.projects !== 'object' || Array.isArray(data.projects)))
    )
      throw new Error('Invalid runner configuration');
    data.projects ??= {};
    for (const folder of request.folders) {
      const record = data.projects[folder] ?? {};
      if (!record || typeof record !== 'object' || Array.isArray(record))
        throw new Error('Invalid runner workspace configuration');
      data.projects[folder] = { ...record, ...request.values };
    }
    next = JSON.stringify(data, null, 2) + '\n';
  }
  if (next === content) return added;
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return added;
}

function seed(file, folders, values, namespace, env) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        lockScript,
        target,
        process.execPath,
        __filename,
        target,
        JSON.stringify({ folders: [...new Set(folders)], values, namespace }),
      ],
      { env, stdio: 'pipe', timeout: 10000, encoding: 'utf8' },
    ),
  );
}
/** Where Codex reads its login when no profile selects another directory. */
const codexHome = (env) => env.CODEX_HOME || path.join(home(env), '.codex');
function trustGrokFolders(folders, env = process.env) {
  const file = path.join(grokHome(env), 'trusted_folders.toml');
  const added = seed(
    file,
    folders,
    { trusted: true, decided_at: Math.floor(Date.now() / 1000) },
    'folders',
    env,
  );
  return { trustedPath: file, added };
}
function farmReviewWorkspace(cwd, owner) {
  const source = fs.realpathSync(cwd);
  const workspace = path.dirname(source);
  const runs = path.dirname(workspace);
  const ownerRoot = path.dirname(runs);
  if (
    path.basename(source) !== 'source' ||
    path.basename(runs) !== 'runs' ||
    path.basename(path.dirname(ownerRoot)) !== 'review-workspaces'
  )
    return false;
  const marker = path.join(workspace, 'identity.json');
  const stat = fs.lstatSync(marker);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Review workspace ownership marker is not private');
  const identity = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (
    typeof identity.owner !== 'string' ||
    identity.workspaceId !== path.basename(workspace) ||
    (owner && identity.owner !== owner) ||
    require('node:crypto').createHash('sha256').update(identity.owner).digest('hex') !==
      path.basename(ownerRoot)
  )
    throw new Error('Review workspace ownership marker does not match this launch');
  return true;
}
// A Grok review checkout stays untrusted, so Grok loads none of its hooks, agents, MCP or LSP
// servers, instructions or skills. The preflight refuses an account that already trusts it.
function checkGrokReviewWorkspace(cwd, env = process.env, owner, launch) {
  if (!farmReviewWorkspace(cwd, owner)) return;
  assertGrokReviewAccount(cwd, env, launch);
}
function configureCodexReviewWorkspace(cwd, env = process.env, owner) {
  if (!farmReviewWorkspace(cwd, owner)) return;
  seed(
    path.join(codexHome(env), 'config.toml'),
    [path.resolve(cwd), fs.realpathSync(cwd)],
    { trust_level: 'untrusted' },
    'projects',
    env,
  );
}
function trustClaudeWorkspace(cwd, env = process.env, owner) {
  if (!farmReviewWorkspace(cwd, owner)) return;
  seed(
    path.join(env.CLAUDE_CONFIG_DIR || home(env), '.claude.json'),
    [path.resolve(cwd), fs.realpathSync(cwd)],
    { hasTrustDialogAccepted: true },
    undefined,
    env,
  );
}
function codexWorkspaceTrustConfig(cwd, trust) {
  return `projects={${JSON.stringify(cwd)}={trust_level=${JSON.stringify(trust)}}}`;
}
const reviewConfigurationRoots = (cwd) =>
  [
    '.grok/config.toml',
    '.grok/hooks',
    '.grok/lsp.json',
    '.grok/plugins',
    '.grok/agents',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/plugins',
    '.cursor/hooks.json',
    '.cursor/mcp.json',
    '.cursor/plugins',
    '.mcp.json',
    '.lsp.json',
    '.envrc',
    '.pi',
    '.opencode',
    'opencode.json',
    'opencode.jsonc',
  ].map((name) => path.join(fs.realpathSync(cwd), name));
// What a Grok review may write in its home: its sessions and logs, and the bytes of the sign-in
// lock that a token refresh takes. Everything else stays read-only: hooks, configuration, policy,
// bundled and user agents, skills, memory, the model catalog cache, the stored login, the external
// sign-in command in bin/, and shell startup files (a profile's HOME is its Grok home). So one
// review cannot change what the next one loads, runs, signs in with or sends requests to.
const grokReviewHomeAccess = (env) => ({
  writablePaths: ['sessions', 'logs'].map((name) => path.join(grokHome(env), name)),
  dataFiles: [path.join(grokHome(env), 'auth.json.lock')],
  // The log an unsandboxed Grok start appends to.
  fixedPaths: [path.join(grokHome(env), 'logs', 'unified.jsonl')],
});
// A Grok review checkout stays untrusted (ADR-057 Amendment 13), and Grok's terminal then stops
// at "Do you trust the contents of this directory?" for any checkout with project configuration.
const terminalReviewRefusalByRunner = {
  grok: "Grok terminal reviews are unavailable: the review checkout stays untrusted and Grok's terminal stops at its folder-trust prompt. Use the native Grok transport.",
};
const reviewConfigurationRootsByRunner = {
  grok: reviewConfigurationRoots,
  claude: reviewConfigurationRoots,
  cursor: reviewConfigurationRoots,
  pi: reviewConfigurationRoots,
  opencode: reviewConfigurationRoots,
};

// The review sandbox denies repository configuration. Exclude it before Claude
// tries to read it, rather than prompting on EPERM before accepting the task.
const piReadOnlyReviewArgs = ['--no-approve'];
const claudeReadOnlyReviewArgs = [
  '--setting-sources',
  'user',
  '--settings',
  '{"disableAllHooks":true}',
];

module.exports = {
  piReadOnlyReviewArgs,
  claudeReadOnlyReviewArgs,
  codexHome,
  grokHome,
  reviewConfigurationRootsByRunner,
  terminalReviewRefusalByRunner,
  grokReviewHomeAccess,
  codexWorkspaceTrustConfig,
  trustGrokFolders,
  checkGrokReviewWorkspace,
  configureCodexReviewWorkspace,
  workspaceTrustByRunner: {
    codex: configureCodexReviewWorkspace,
    grok: checkGrokReviewWorkspace,
    claude: trustClaudeWorkspace,
  },
  trustClaudeWorkspace,
};
if (require.main === module)
  console.log(JSON.stringify(writeTrust(process.argv[2], JSON.parse(process.argv[3]))));
