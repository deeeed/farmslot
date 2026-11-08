// Resolve the published mm-harness executable from the configured package root.
// Lifecycle hooks and task marking use this installation, never the mutable
// tooling checkout a slot is editing.
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@deeeed/metamask-harness';

function expandHome(value) {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Return the published harness executable, refusing a root inside the slot checkout. */
export function resolvePublishedHarness(env, checkout) {
  const configured = env.MM_HARNESS_PACKAGE_ROOT;
  if (!configured?.trim()) throw new Error('MM_HARNESS_PACKAGE_ROOT is required');
  const root = realpathSync(expandHome(configured.trim()));
  if (checkout && within(realpathSync(checkout), root))
    throw new Error('MM_HARNESS_PACKAGE_ROOT must name a published installation, not the slot checkout');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== PACKAGE) throw new Error(`Configured root is not ${PACKAGE}`);
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['mm-harness'];
  if (typeof entry !== 'string' || !entry) throw new Error('Configured package has no mm-harness command');
  const command = realpathSync(path.resolve(root, entry));
  if (!within(root, command)) throw new Error('mm-harness command escapes its package root');
  accessSync(command, constants.X_OK);
  return command;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const flag = process.argv.indexOf('--published');
  const checkout = flag >= 0 ? process.argv[flag + 1] : undefined;
  try {
    process.stdout.write(resolvePublishedHarness(process.env, checkout));
  } catch (error) {
    console.error(
      `Published harness unavailable: ${error.message}. Configure MM_HARNESS_PACKAGE_ROOT in the pool env to an installed @deeeed/metamask-harness.`,
    );
    process.exitCode = 1;
  }
}
