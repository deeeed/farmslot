import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: unknown };

if (typeof packageJson.version !== 'string' || !packageJson.version) {
  throw new Error('@farmslot/recipe-cli package version is missing.');
}

export const RECIPE_CLI_VERSION = packageJson.version;

/** Packages this CLI vouches for when a library declares `requires`. */
export const RECIPE_CLI_PACKAGE_VERSIONS: Readonly<Record<string, string>> = {
  '@farmslot/recipe-cli': RECIPE_CLI_VERSION,
};
