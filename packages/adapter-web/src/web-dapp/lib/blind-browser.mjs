import { execFileSync } from 'node:child_process';

// This opt-in is supplied by the blind worker boundary, never a general Chrome
// flag. LaunchServices would delegate to an unsandboxed service, so spawn directly.
export function blindBrowserOptions(env) {
  const mode = env.FARMSLOT_BLIND_SEATBELT;
  if (mode === undefined) return { args: [], direct: false };
  if (mode !== '1') throw new Error('invalid blind seatbelt browser mode');
  const active =
    process.platform === 'darwin' &&
    execFileSync(
      'python3',
      [
        '-c',
        `
import ctypes, os
lib = ctypes.CDLL('/usr/lib/libsandbox.dylib')
print(lib.sandbox_check(os.getpid(), None, 0))
`,
      ],
      { encoding: 'utf8', timeout: 2000 },
    ).trim() === '1';
  if (!active) throw new Error('blind browser needs an active macOS seatbelt');
  return { args: ['--no-sandbox'], direct: true };
}
