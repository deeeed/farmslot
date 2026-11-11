import { execFileSync } from 'node:child_process';

// /usr/bin/python3 opens an install dialog until Command Line Tools exist.
// Resolve a real interpreter before any native probe can steal keyboard focus.
export function pythonFor({ found, platform = process.platform, developerDir }) {
  if (!found) return null;
  if (platform === 'darwin' && found === '/usr/bin/python3' && !developerDir()) return null;
  return found;
}

function output(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();
  } catch (error) {
    // which exits 1 when absent; xcode-select exits 2 before CLT is installed.
    if (error.status === 1 || error.status === 2 || error.code === 'ENOENT') return '';
    throw error;
  }
}

let pythonChoice;
export function usablePython() {
  if (pythonChoice === undefined) {
    pythonChoice = pythonFor({
      found: output('/usr/bin/which', ['python3']),
      developerDir: () => output('/usr/bin/xcode-select', ['-p']),
    });
  }
  return pythonChoice;
}
