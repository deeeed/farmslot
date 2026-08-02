import { execOnSlot } from '../core/exec.js';

import type { SlotVars } from './observability-types.js';

/** Read the slot clock used by runner-native event timestamps. */
export async function readSlotClockMs(vars: SlotVars): Promise<number> {
  const result = await execOnSlot(
    vars,
    `python3 -c 'import time; print(time.time_ns() // 1000000)'`,
    { timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Runner observability clock probe failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  const clockMs = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isSafeInteger(clockMs) || clockMs <= 0) {
    throw new Error(`Invalid runner observability clock probe: ${result.stdout.trim()}`);
  }
  return clockMs;
}
