import { digestFileWithinRoot as digestContainedFile } from './core/path.js';

/** Public reader signature keeps private filesystem types out of consumer declarations. */
export const digestFileWithinRoot: (root: string, relativePath: string) => Promise<string> =
  digestContainedFile;
