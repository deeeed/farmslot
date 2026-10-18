/** One row of `ps -axo pid=,ppid=,pgid=,lstart=,<comm|args>=`. */
export interface ProcessCensusRow {
  pid: string;
  parent: string;
  group: number;
  /** The start time, whitespace-normalized: with the pid, a process identity. */
  identity: string;
  command: string;
}

export function parseProcessCensus(stdout: string): ProcessCensusRow[] {
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(line);
    return match
      ? [
          {
            pid: match[1],
            parent: match[2],
            group: Number(match[3]),
            identity: match[4].replace(/\s+/g, ' '),
            command: match[5],
          },
        ]
      : [];
  });
}

/** `lsof -Fpn` output as [pid, name] pairs, in output order. */
export function parseLsofNames(stdout: string): Array<[string, string]> {
  const names: Array<[string, string]> = [];
  let pid = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    if (line.startsWith('n')) names.push([pid, line.slice(1)]);
  }
  return names;
}

export function isWithinPath(root: string, file: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}

/** A tmux server or client: it hosts the slot session, it never occupies the checkout. */
export function isTmuxProcess(command: string): boolean {
  const name = command.split(/\s/, 1)[0].split('/').at(-1);
  return name === 'tmux' || name === 'tmux:';
}
