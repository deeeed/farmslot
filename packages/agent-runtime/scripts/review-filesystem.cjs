const { accessSync, constants } = require('node:fs');
const { lstat, mkdir, realpath, writeFile } = require('node:fs/promises');
const { basename, dirname, join, sep } = require('node:path');

function available() {
  if (process.platform !== 'darwin') return false;
  try {
    accessSync('/usr/bin/sandbox-exec', constants.X_OK);
    return true;
  } catch (error) {
    if (['ENOENT', 'EACCES'].includes(error.code)) return false;
    throw error;
  }
}
async function sandbox(policy, runtimeRoots, configurationRoots = [], runtimeAccess = {}) {
  if (!available())
    throw new Error('This runner needs the macOS review sandbox on its execution node');
  const temporaryDirectory = join(policy.writableRoots[0], '.review-runtime', 'tmp');
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const writable = await Promise.all(policy.writableRoots.map((root) => realpath(root)));
  const readOnly = await Promise.all(policy.readOnlyRoots.map((root) => realpath(root)));
  for (const root of runtimeRoots) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    writable.push(await realpath(root));
  }
  // A runtime root that names writable paths or data files is read-only apart from them, and no
  // link can be made in it, so one review cannot change what the next one loads, runs or writes.
  const runtime = writable.slice(policy.writableRoots.length);
  const inRuntime = async (file) => {
    const resolved = join(await realpath(dirname(file)), basename(file));
    if (!runtime.some((root) => resolved.startsWith(root + sep)))
      throw new Error('Writable review runtime path must belong to a runtime root');
    return resolved;
  };
  const runtimeWritable = [];
  for (const file of runtimeAccess.writablePaths ?? []) runtimeWritable.push(await inRuntime(file));
  // A data file keeps its identity: a review may write its bytes but not replace, rename or
  // remove it, so a later process that opens it cannot be pointed elsewhere.
  const runtimeData = [];
  for (const file of runtimeAccess.dataFiles ?? []) {
    const resolved = await inRuntime(file);
    try {
      await writeFile(resolved, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (!(await lstat(resolved)).isFile())
      throw new Error('Review runtime data file must be a regular file');
    runtimeData.push(resolved);
  }
  const restrictedRuntime = runtime.filter((root) =>
    [...runtimeWritable, ...runtimeData].some((file) => file.startsWith(root + sep)),
  );
  const blockedConfiguration = [];
  for (const file of configurationRoots) {
    const source = readOnly.find((root) => file.startsWith(root + sep));
    if (!source) throw new Error('Review configuration mask must belong to its read-only source');
    blockedConfiguration.push(file);
    try {
      const target = await realpath(file);
      if (target !== file) {
        if (!target.startsWith(source + sep))
          throw new Error('Review execution configuration links outside its source');
        blockedConfiguration.push(target);
      }
    } catch (error) {
      // An absent config is inert. The path remains denied if anything later appears there.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    ...writable.map((root) => `(allow file-write* (subpath ${JSON.stringify(root)}))`),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
    ...readOnly.map((root) => `(deny file-write* (subpath ${JSON.stringify(root)}))`),
    ...restrictedRuntime.map((root) => `(deny file-write* (subpath ${JSON.stringify(root)}))`),
    ...runtimeWritable.map((file) => `(allow file-write* (subpath ${JSON.stringify(file)}))`),
    ...runtimeData.map((file) => `(allow file-write-data (literal ${JSON.stringify(file)}))`),
    ...restrictedRuntime.map(
      (root) =>
        `(deny file-write-create (require-all (subpath ${JSON.stringify(root)}) (vnode-type SYMLINK)))`,
    ),
    ...restrictedRuntime.map((root) => `(deny file-link (subpath ${JSON.stringify(root)}))`),
    ...blockedConfiguration.map(
      (root) => `(deny file-read-data (subpath ${JSON.stringify(root)}))`,
    ),
  ].join('\n');
  return {
    sandbox: { executable: '/usr/bin/sandbox-exec', args: ['-p', profile] },
    temporaryDirectory,
  };
}
module.exports = { available, sandbox };
