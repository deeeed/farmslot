import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: unknown };

if (typeof packageJson.version !== 'string' || !packageJson.version) {
  throw new Error('@farmslot/expo-recipe package version is missing.');
}

/** Packages this host vouches for when a recipe library declares `requires`. */
export const EXPO_RECIPE_PACKAGE_VERSIONS: Readonly<Record<string, string>> = {
  '@farmslot/expo-recipe': packageJson.version,
};
