import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The tree this module runs from (src/ or dist/), the scripts the host loads, and the manifest.
// The client starts the supervisor from its own tree, so both hash the same files.
const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(moduleRoot);
const runtimeFile = /\.(?:[cm]?js|ts|json)$/;
const excluded = /(?:\.test\.|\.test-support\.|\.d\.[cm]?ts$|\.map$)/;

function runtimeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : runtimeFiles(file);
    return entry.isFile() && runtimeFile.test(entry.name) && !excluded.test(entry.name)
      ? [file]
      : [];
  });
}

/**
 * A content hash of the installed runtime. A source deploy rebuilds the code without changing
 * the package version, so the version alone cannot tell a host that runs older code.
 */
export function runtimeBuildIdentity(
  root = packageRoot,
  trees = [relative(packageRoot, moduleRoot), 'scripts'],
): string {
  const hash = createHash('sha256');
  const files = [
    join(root, 'package.json'),
    ...trees.flatMap((tree) => runtimeFiles(join(root, tree))),
  ];
  for (const file of files.map((path) => relative(root, path)).sort()) {
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(join(root, file)))
      .update('\0');
  }
  return hash.digest('hex');
}

let current: string | undefined;
/** This process's runtime build, read once. */
export function currentRuntimeBuild(): string {
  current ??= runtimeBuildIdentity();
  return current;
}
