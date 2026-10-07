// Whether the macOS login session is locked. macOS stops painting visible
// windows while it is, so a headful browser's screenshots, video and UI actions
// stall until their own timeouts. The launcher refuses a headful launch up front
// instead (SESSION_LOCKED).

import { spawnSync as nodeSpawnSync } from 'node:child_process';

export const SESSION_LOCKED_MESSAGE =
  "The macOS login session is locked, so the headful browser can't paint (screenshots, video and UI actions stall).";
export const SESSION_LOCKED_USER_ACTION =
  'Unlock the Mac and keep its login session unlocked while the run drives the browser, then rerun. ' +
  'caffeinate keeps the Mac awake but does not unlock it.';

const LOCKED = /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/u;
const ON_CONSOLE = /<key>kCGSSessionOnConsoleKey<\/key>\s*<true\/>/u;

/**
 * `ioreg -n Root -d1 -a` output: the lock flag of the on-console session in
 * IOConsoleUsers (any session's when none is on console); false for a plist
 * without it, null for anything else.
 * @param {string} output
 * @returns {boolean | null}
 */
export function parseSessionLocked(output) {
  if (!/<plist[\s>]/u.test(output)) return null;
  const users = /<key>IOConsoleUsers<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(output)?.[1] ?? '';
  const onConsole = users
    .match(/<dict>[\s\S]*?<\/dict>/gu)
    ?.find((session) => ON_CONSOLE.test(session));
  return LOCKED.test(onConsole ?? output);
}

/**
 * true or false on macOS; null when unknown (another platform, or ioreg failed
 * or took longer than 3 s). Never throws.
 * @param {{ platform?: string, spawnSync?: typeof nodeSpawnSync }} [deps]
 * @returns {boolean | null}
 */
export function macosSessionLocked({
  platform = process.platform,
  spawnSync = nodeSpawnSync,
} = {}) {
  if (platform !== 'darwin') return null;
  try {
    const result = spawnSync('ioreg', ['-n', 'Root', '-d1', '-a'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return null;
    return parseSessionLocked(String(result.stdout));
  } catch {
    return null;
  }
}
