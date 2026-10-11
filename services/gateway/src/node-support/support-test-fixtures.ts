export function isSupportHomeCommand(command: string): boolean {
  return command.startsWith("printf '%s");
}

export function fakeSupportHomeResult(command: string) {
  if (!isSupportHomeCommand(command)) return undefined;
  const hash = /support\/([a-f0-9]{64})/.exec(command)?.[1];
  if (!hash) throw new Error('Support-home probe has no bundle hash');
  return { exitCode: 0, stdout: `/tmp/node-home/farmslot-node/support/${hash}\n`, stderr: '' };
}
