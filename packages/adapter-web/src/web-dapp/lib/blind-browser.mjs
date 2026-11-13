import { execFileSync } from 'node:child_process';

import { PYTHON_TIMEOUT_MS, usablePython } from './python.mjs';

// This opt-in is supplied by the blind worker boundary, never a general Chrome
// flag. LaunchServices would delegate to an unsandboxed service, so spawn directly.
function activeSeatbelt() {
  const python = usablePython();
  if (!python) throw new Error('blind browser requires a usable python3');
  return (
    execFileSync(
      python,
      [
        '-c',
        `
import ctypes, os
lib = ctypes.CDLL('/usr/lib/libsandbox.dylib')
print(lib.sandbox_check(os.getpid(), None, 0))
`,
      ],
      { encoding: 'utf8', timeout: PYTHON_TIMEOUT_MS },
    ).trim() === '1'
  );
}

export function blindBrowserOptions(
  env,
  { platform = process.platform, sandboxed = activeSeatbelt } = {},
) {
  const mode = env.FARMSLOT_BLIND_SEATBELT;
  if (mode === undefined) return { args: [], direct: false };
  if (mode !== '1') throw new Error('invalid blind seatbelt browser mode');
  const active = platform === 'darwin' && sandboxed();
  if (!active) throw new Error('blind browser needs an active macOS seatbelt');
  return { args: ['--no-sandbox'], direct: true };
}
