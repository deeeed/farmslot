import path from 'node:path';

import type { loadSlotVars } from '../core/config.js';
import { slotWriteFiles } from '../core/slot-io.js';

import { runnerObservabilityDirForSlot } from './observability-files.js';
import { instructionNeedle, runnerPromptDigest } from './observability-prompt-digest.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export async function writeRunnerPromptSentinel(
  vars: SlotVars,
  message: string,
): Promise<{ digest: string; sentAt: number }> {
  const digest = runnerPromptDigest(message);
  const sentAt = Date.now();
  const obsDir = await runnerObservabilityDirForSlot(vars);
  const payload = JSON.stringify({
    sentAt,
    digest,
    prompt: instructionNeedle(message),
  });
  await slotWriteFiles(vars, path.posix.join(obsDir, 'sent'), [
    {
      path: `${digest}.json`,
      content: Buffer.from(`${payload}\n`).toString('base64'),
    },
  ]);
  return { digest, sentAt };
}
