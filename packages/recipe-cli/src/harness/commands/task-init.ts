// task init — the host's entrypoint for the shared task-directory producer
// (@farmslot/agent-runtime). The runtime owns the layout (TASK.md, CHECKLIST.md,
// mark, inputs/); this wrapper adds the defaults only the host knows.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { contextAdapter } from '../context-state.js';
import { harnessHost } from '../host.js';
import { harnessExecutable } from '../paths.js';
import { EXIT } from '../shared.js';

const require = createRequire(import.meta.url);

export interface TaskInitCommandOptions {
  // The task's run surface when --surface is absent.
  surface?: string;
}

function hasOption(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

// Defaults the shared producer cannot derive: the host's surface, a mark shim
// that routes through the host's checklist gates instead of the runtime's own
// engine, and the platform of the checkout the command runs in. Run mode is not
// one of them: only a control plane knows it, and it selects nothing here.
function hostDefaults(argv: readonly string[], options: TaskInitCommandOptions): string[] {
  const defaults: string[] = [];
  if (options.surface && !hasOption(argv, '--surface')) defaults.push('--surface', options.surface);
  if (!hasOption(argv, '--mark-command')) {
    defaults.push('--mark-command', `${harnessExecutable()} checklist mark`);
  }
  if (!hasOption(argv, '--platform')) {
    const adapter = contextAdapter(process.cwd());
    if (adapter) defaults.push('--platform', adapter);
  }
  return defaults;
}

export async function handleTaskInit(
  argv: string[],
  options: TaskInitCommandOptions = {},
): Promise<number> {
  const host = harnessHost().name;
  if (argv[0] !== 'init') {
    console.error(`usage: ${host} task init <task-dir> --flow f --template id --title t [options]`);
    return EXIT.usage;
  }
  const forwarded = argv.slice(1);

  let entrypoint: string;
  try {
    entrypoint = require.resolve('@farmslot/agent-runtime/scripts/task-init-cli.mjs');
  } catch (error) {
    console.error(
      `${host} task init: installed @farmslot/agent-runtime does not expose the task-directory command: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EXIT.runtime;
  }

  const result = spawnSync(
    process.execPath,
    [entrypoint, ...forwarded, ...hostDefaults(forwarded, options)],
    { env: process.env, stdio: 'inherit' },
  );
  if (result.error) {
    console.error(`${host} task init: ${result.error.message}`);
    return EXIT.runtime;
  }
  return result.status ?? EXIT.runtime;
}
