import path from 'node:path';

import { type loadSlotVars,resolveProjectRuntimeDir } from '../core/config.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';

import { instructionNeedle, runnerPromptDigest } from './observability-prompt-digest.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export async function writeRunnerPromptSentinel(
  vars: SlotVars,
  message: string,
): Promise<{ digest: string; sentAt: number }> {
  const digest = runnerPromptDigest(message);
  const sentAt = Date.now();
  const runtimeDir = await resolveProjectRuntimeDir(vars.projectName);
  const relativeSentPath = path.posix.join(
    runtimeDir,
    '.observability',
    'sent',
    `${digest}.json`,
  );
  const payload = JSON.stringify({
    sentAt,
    digest,
    prompt: instructionNeedle(message),
  });
  await writeTextFileOnSlot(vars, relativeSentPath, `${payload}\n`);
  return { digest, sentAt };
}