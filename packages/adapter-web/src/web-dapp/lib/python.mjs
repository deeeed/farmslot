import { execFileSync } from 'node:child_process';

// /usr/bin/python3 opens an install dialog until Command Line Tools exist.
// Resolve a real interpreter before any native probe can steal keyboard focus.
export function pythonFor({ found, platform = process.platform, developerDir }) {
  if (!found) return null;
  if (platform === 'darwin' && found === '/usr/bin/python3' && !developerDir()) return null;
  return found;
}

// A version-manager shim (asdf, pyenv) is a shell script that can take seconds
// to start on a loaded host. Every python spawn gets this budget.
export const PYTHON_TIMEOUT_MS = 15000;

function output(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PYTHON_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    // which exits 1 when absent; xcode-select exits 2 before CLT is installed.
    if (error.status === 1 || error.status === 2 || error.code === 'ENOENT') return '';
    throw error;
  }
}

// The found python3 may be a shim: ask it once for the interpreter it runs, and
// spawn that binary for every probe, so the shim's startup is paid once.
let pythonChoice;
export function usablePython() {
  if (pythonChoice === undefined) {
    const found = pythonFor({
      found: output('/usr/bin/which', ['python3']),
      developerDir: () => output('/usr/bin/xcode-select', ['-p']),
    });
    pythonChoice = found && (output(found, ['-c', 'import sys; print(sys.executable)']) || null);
  }
  return pythonChoice;
}
