// Interpreter routing for adapter shell and node leaves.
import fs from 'node:fs';
import path from 'node:path';

import { harnessHost } from './host.js';

// Returns the interpreter and args for invoking a leaf. Shell leaves (.sh) run
// through bash so the file mode does not need to be executable. Node leaves
// are already invoked through process.execPath by their callers and are
// returned unchanged.
export function resolveLeafInvoke(
  command: string,
  args: string[],
): { bin: string; args: string[] } {
  if (command.endsWith('.sh')) return { bin: 'bash', args: [command, ...args] };
  return { bin: command, args };
}

// Teaching diagnostic for a shell leaf that is absent from disk. Bash exits
// 127 (not a Node spawn error) for a missing file, so callers pre-check and
// emit this rather than relying on result.error.
export function missingShellLeafMessage(leafPath: string): string {
  const leaf = path.basename(leafPath);
  return (
    `leaf could not start: ${leaf} (ENOENT)\n` +
    `  Next: reinstall ${harnessHost().name} (npm i -g ${harnessHost().packageName}) — the shell leaf is missing or not executable`
  );
}

// Returns true when a .sh leaf path does not exist on disk.
export function shellLeafMissing(leafPath: string): boolean {
  return leafPath.endsWith('.sh') && !fs.existsSync(leafPath);
}
