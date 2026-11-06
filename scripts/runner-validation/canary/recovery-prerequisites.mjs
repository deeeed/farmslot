import * as runtimeModule from 'node:module';

export function requireRecoveryFaultSupport(nodeVersion = process.versions.node) {
  const [major, minor, patch] = nodeVersion.split('.').map(Number);
  // Earlier 22.x releases reject CommonJS passed through the sync hook and tsx.
  const supportedVersion =
    major > 22 || (major === 22 && (minor > 22 || (minor === 22 && patch >= 3)));
  if (!supportedVersion || typeof runtimeModule.registerHooks !== 'function')
    throw new Error(
      'Recovery matrix requires Node 22.22.3+ with node:module.registerHooks for the fault hook and tsx loader chain; upgrade Node before starting the isolated stack.',
    );
}
