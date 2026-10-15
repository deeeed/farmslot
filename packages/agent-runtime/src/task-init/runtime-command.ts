import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Double quotes preserve spaces and the remote slot's $HOME expansion. */
export function quoteMarkCommandWord(word: string): string {
  return `"${word.replace(/(["\\`])/g, '\\$1')}"`;
}

/** Use the SDK installation that writes the task. */
export function installedRuntimeScriptCommand(filename: string): string {
  return `node ${quoteMarkCommandWord(path.join(packageRoot, 'scripts', filename))}`;
}

/** Retained paths are literal shell arguments. */
export function quoteTaskPath(word: string): string {
  return `'${word.replace(/'/g, `'"'"'`)}'`;
}

export function installedTaskCommands(mapPath?: (file: string) => string): {
  AC_CMD: string;
  ARTIFACT_CHECK_CMD: string;
} {
  const file = path.join(packageRoot, 'bin/farmslot-agent.mjs');
  const entry = `node ${mapPath ? quoteTaskPath(mapPath(file)) : quoteMarkCommandWord(file)}`;
  return { AC_CMD: `${entry} ac`, ARTIFACT_CHECK_CMD: `${entry} artifact-check` };
}
