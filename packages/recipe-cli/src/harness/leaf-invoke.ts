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

// Teaching diagnostic for a leaf that could not start: the host's own install
// is incomplete, so the next step reinstalls it.
export function leafStartFailureMessage(leaf: string, code: string, kind = 'shell leaf'): string {
  const host = harnessHost();
  return (
    `leaf could not start: ${leaf} (${code})\n` +
    `  Next: reinstall ${host.name} (npm i -g ${host.packageName}) — the ${kind} is missing or not executable`
  );
}

// A shell leaf absent from disk. Bash exits 127 (not a Node spawn error) for a
// missing file, so callers pre-check and emit this rather than relying on
// result.error.
export function missingShellLeafMessage(leafPath: string): string {
  return leafStartFailureMessage(path.basename(leafPath), 'ENOENT');
}

// Returns true when a .sh leaf path does not exist on disk.
export function shellLeafMissing(leafPath: string): boolean {
  return leafPath.endsWith('.sh') && !fs.existsSync(leafPath);
}
