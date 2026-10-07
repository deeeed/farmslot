// execution-template — the host's entrypoint for the shared checklist catalog
// (@farmslot/agent-runtime).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { harnessHost } from '../host.js';

const require = createRequire(import.meta.url);

export async function handleExecutionTemplate(argv: string[]): Promise<number> {
  const host = harnessHost().name;
  let entrypoint: string;
  try {
    entrypoint = require.resolve('@farmslot/agent-runtime/scripts/execution-template-cli.mjs');
  } catch (error) {
    console.error(
      `${host} execution-template: installed @farmslot/agent-runtime does not expose the catalog command: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  const result = spawnSync(process.execPath, [entrypoint, ...argv], {
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`${host} execution-template: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
