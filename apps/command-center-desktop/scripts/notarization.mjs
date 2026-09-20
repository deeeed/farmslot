import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function requireNotarizationCredentials(env) {
  const groups = [
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    ['APPLE_KEYCHAIN_PROFILE'],
  ];
  for (const names of groups) {
    // Match electron-builder's precedence so a partial higher-priority method fails closed.
    const triggers = names[0] === 'APPLE_ID' ? names.slice(0, 2) : names;
    if (!triggers.some((name) => env[name])) continue;
    const missing = names.filter((name) => !env[name]?.trim());
    if (missing.length)
      throw new Error(`Missing notarization environment variables: ${missing.join(', ')}`);
    return;
  }
  throw new Error(
    'Notarization credentials are required. See README.md before creating a distribution build.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'preflight') {
    requireNotarizationCredentials(process.env);
  } else if (process.argv[2] === 'verify') {
    const app = resolve('release/mac-arm64/Farmslot.app');
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
    execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose', app], {
      stdio: 'inherit',
    });
  } else {
    throw new Error('Expected preflight or verify.');
  }
}
