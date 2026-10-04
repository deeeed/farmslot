import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: unknown };

if (typeof packageJson.version !== 'string' || !packageJson.version) {
  throw new Error('@farmslot/recipe-runner package version is missing.');
}

export const RECIPE_RUNNER_VERSION = packageJson.version;
