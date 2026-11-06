import * as runtimeModule from 'node:module';

export function requireRecoveryFaultSupport(nodeVersion = process.versions.node) {
  const [major, minor, patch] = nodeVersion.split('.').map(Number);
  // Node #59929 fixes CommonJS passed through sync and async hooks. It never
  // reached 23.x; the 22.x, 24.x and 25.x releases have separate minimums.
  const supportedVersion =
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) ||
    (major === 24 && (minor > 11 || (minor === 11 && patch >= 1))) ||
    (major === 25 && minor >= 1) ||
    major >= 26;
  if (!supportedVersion || typeof runtimeModule.registerHooks !== 'function')
    throw new Error(
      'Recovery matrix requires Node 22.x >= 22.22.3, 24.x >= 24.11.1, 25.x >= 25.1.0, or 26+ with node:module.registerHooks for the fault hook and tsx loader chain; 23.x is unsupported; upgrade Node before starting the isolated stack.',
    );
}
