import { taskInit } from '@farmslot/agent-runtime';
import type { Run } from '@farmslot/protocol';

/** Exercise gateway data composition and the shared renderer without a worker RPC. */
export async function writeTaskFixture(
  run: Run,
  options?: Parameters<typeof import('./writer.js').writeTaskFile>[1],
): Promise<string> {
  const { initializeWrittenTask, writeTaskFile } = await import('./writer.js');
  const taskFile = await writeTaskFile(run, options);
  await initializeWrittenTask(
    { ...run, taskFile },
    {
      initializeTask: async (_slot, directory, input) => {
        const result = await taskInit({
          ...input.task,
          taskDir: directory,
          template: { sources: [], selection: input.template },
        });
        return result.executionTemplate;
      },
    },
  );
  return taskFile;
}
