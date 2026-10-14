const { accessSync, constants } = require('node:fs');
const { mkdir, realpath } = require('node:fs/promises');
const { join, sep } = require('node:path');

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
async function sandbox(policy, runtimeRoots, configurationRoots = []) {
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
