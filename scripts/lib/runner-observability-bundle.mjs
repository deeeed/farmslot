import { createHash } from 'node:crypto';

import { expandTilde } from './provider-accounts.mjs';

export const RUNNER_OBSERVABILITY_COPY_PATHS = [
  'scripts/runners/hook-progress.mjs',
  'scripts/runners/pi-farmslot-observability.ts',
  'scripts/runners/pi-farmslot-hook-writer.mjs',
  'scripts/runners/pi-farmslot-providers.mjs',
  'scripts/runners/pi-farmslot-task.mjs',
];
export const RUNNER_OBSERVABILITY_SUPPORT_PATHS = [
  'scripts/install-runner-observability.mjs',
  'scripts/lib/runner-runtime.cjs',
  'scripts/lib/provider-accounts.mjs',
  'scripts/lib/runner-observability-bundle.mjs',
  'packages/agent-runtime/scripts/toml-scan.cjs',
  'packages/agent-runtime/scripts/review-account-preflight.cjs',
  'packages/agent-runtime/scripts/workspace-trust.cjs',
  ...RUNNER_OBSERVABILITY_COPY_PATHS,
];
export const RUNNER_OBSERVABILITY_SOURCE_FILES = RUNNER_OBSERVABILITY_SUPPORT_PATHS.map(
  (relativePath) => ({ relativePath }),
);
export const RUNNER_OBSERVABILITY_COPY_FILES = RUNNER_OBSERVABILITY_COPY_PATHS.map(
  (relativePath) => ({
    relativePath,
    sourcePath: 'bin/' + relativePath.split('/').at(-1),
  }),
);

// Preserve the existing node-support manifest byte format.
export function supportHash(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.mode.toString(8));
    hash.update('\0');
    hash.update(Buffer.from(file.contentBase64, 'base64'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// Standalone functions are serialized into the existing worker probe, using only Node builtins.
export async function readSupportFiles(root, entries) {
  const { readFile, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  root = expandTilde(root);
  return Promise.all(
    entries.map(async (entry) => {
      const file = join(root, entry.sourcePath ?? entry.relativePath);
      const [content, info] = await Promise.all([readFile(file), stat(file)]);
      return {
        relativePath: entry.relativePath,
        contentBase64: content.toString('base64'),
        mode: info.mode & 0o777,
      };
    }),
  );
}

export async function verifySupportBundle(root, expectedHash, entries) {
  try {
    if (!root) throw new Error('No selected runner support bundle');
    const files = await readSupportFiles(root, entries);
    const hash = supportHash(files);
    if (expectedHash && hash !== expectedHash)
      throw new Error(`expected ${expectedHash}, found ${hash}`);
    return { files, hash };
  } catch (error) {
    throw Object.assign(
      new Error(
        `RUNNER_OBSERVABILITY_BUNDLE_MISMATCH: ${error.message}. Restart the gateway and prepare the matching support bundle before retrying.`,
        { cause: error },
      ),
      { code: 'RUNNER_OBSERVABILITY_BUNDLE_MISMATCH' },
    );
  }
}

export function supportVerificationProgram() {
  return `const {createHash}=require('node:crypto'),os=require('node:os'),path=require('node:path');
${expandTilde.toString()}\n${supportHash.toString()}\n${readSupportFiles.toString()}\n${verifySupportBundle.toString()}\n`;
}
