import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function eslintCacheFingerprint({
  eslintVersion,
  toolVersionsContent,
  configContent,
  lockfileContent,
}) {
  return createHash('sha256')
    .update(eslintVersion)
    .update('\0')
    .update(toolVersionsContent)
    .update('\0')
    .update(configContent)
    .update('\0')
    .update(lockfileContent)
    .digest('hex')
    .slice(0, 16);
}

export function buildEslintArgs({ cacheLocation, fix = false, target = '.' }) {
  const args = [
    target,
    '--format',
    'json',
    '--cache',
    '--cache-location',
    cacheLocation,
    '--cache-strategy',
    'content',
  ];
  if (fix) args.push('--fix');
  return args;
}

export function repoEslintCacheLocation({ repoRoot, eslintPackagePath }) {
  const eslintPackage = JSON.parse(readFileSync(eslintPackagePath, 'utf8'));
  const fingerprint = eslintCacheFingerprint({
    eslintVersion: eslintPackage.version,
    toolVersionsContent: readFileSync(join(repoRoot, '.tool-versions'), 'utf8'),
    configContent: readFileSync(join(repoRoot, 'eslint.config.mjs'), 'utf8'),
    lockfileContent: readFileSync(join(repoRoot, 'yarn.lock'), 'utf8'),
  });
  return join(repoRoot, '.cache', 'eslint', `ratchet-${fingerprint}.cache`);
}
