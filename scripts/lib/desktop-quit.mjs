import { execFileSync } from 'node:child_process';

/** Accept the real native quit sheet for one explicitly selected test process. */
export function confirmDesktopQuit(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid desktop process ID.');
  execFileSync(
    'osascript',
    [
      '-e',
      `tell application "System Events"
      repeat 100 times
        tell (first process whose unix id is ${pid})
          if exists sheet 1 of window 1 then
            click button "Quit" of sheet 1 of window 1
            return
          end if
        end tell
        delay 0.05
      end repeat
      error "Desktop quit confirmation did not appear"
    end tell`,
    ],
    { timeout: 10000, stdio: 'pipe' },
  );
}
