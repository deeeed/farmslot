import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';

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

function output(command, args, env = process.env) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PYTHON_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    // which exits 1 when absent; xcode-select exits 2 before CLT is installed.
    if (error.status === 1 || error.status === 2 || error.code === 'ENOENT') return '';
    throw error;
  }
}

// These make sys.executable report another binary, which could be the stub.
const EXECUTABLE_OVERRIDES = ['PYTHONEXECUTABLE', '__PYVENV_LAUNCHER__'];

function executableFile(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// The found python3 may be a shim: ask it once for the interpreter it runs, and
// spawn that binary for every probe, so the shim's startup is paid once. null:
// no usable python3. undefined: the shim failed to answer; try again later.
export function resolvePython({
  run = output,
  platform = process.platform,
  env = process.env,
} = {}) {
  const developerDir = () => run('/usr/bin/xcode-select', ['-p']);
  const found = pythonFor({ found: run('/usr/bin/which', ['python3']), platform, developerDir });
  if (!found) return null;
  const clean = Object.fromEntries(
    Object.entries(env).filter(([name]) => !EXECUTABLE_OVERRIDES.includes(name)),
  );
  const real = run(found, ['-c', 'import sys; print(sys.executable)'], clean);
  if (!real || !executableFile(real)) return undefined;
  return pythonFor({ found: real, platform, developerDir });
}

let pythonChoice;
export function usablePython() {
  if (pythonChoice === undefined) pythonChoice = resolvePython();
  return pythonChoice ?? null;
}
