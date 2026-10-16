const path = require('node:path').posix;

// A sibling slot runtime is identical on the gateway and execution host. No
// gateway HOME/TMPDIR is substituted into paths belonging to a remote node.
function runnerRuntimeDir(repo, runtimeDir = '.agent') {
  const root = path.normalize(repo);
  const configured =
    runtimeDir.startsWith('/') || runtimeDir.startsWith('~/')
      ? path.normalize(runtimeDir)
      : path.join(root, runtimeDir);
  const relative = path.relative(root, configured);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return configured;
  }
  return path.join(
    path.dirname(root),
    '.farmslot-runtime',
    path.basename(root),
    relative || 'runtime',
  );
}

module.exports = { runnerRuntimeDir };
