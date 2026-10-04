// stop — stop the dev server this checkout owns, through the platform's
// `devServer`, plus any companion processes the host started for it.

import { harnessAdapter } from '../adapters.js';
import { color } from '../cli-color.js';
import { harnessHost } from '../host.js';
import { optionFlag, optionString, parseArgs, resolveAdapter, shellQuote } from '../parse-args.js';
import { usageOut } from '../shared.js';

export interface StoppedCompanion {
  // Named in the summary: "stopped <label> <pid>".
  label: string;
  pid: number;
}

export interface StopCommandOptions {
  // Stops the host's own processes for the checkout (for example a collector a
  // run started) and returns the ones it stopped.
  companions?(target: string): Promise<StoppedCompanion[]>;
}

export async function handleStop(
  argv: string[],
  commandOptions: StopCommandOptions = {},
): Promise<number> {
  const { options } = parseArgs(argv);
  const json = optionFlag(options, 'json');
  const { adapter, target } = resolveAdapter(options);
  const surface = harnessAdapter(adapter);
  surface.resolveSlotPorts(target);
  const explicitPort = optionString(options, 'port') ?? optionString(options, 'watcherPort');
  if (explicitPort) {
    process.env.WATCHER_PORT = explicitPort;
    process.env.METRO_PORT = explicitPort;
  }
  const stop = surface.devServer.stop(target);
  if (stop.kind === 'headless') {
    return usageOut(json, 'stop', stop.message, stop.userAction);
  }
  const companions = (await commandOptions.companions?.(target)) ?? [];
  const signalled = (stop.signalled ?? 0) + companions.length;
  const summary = [
    stop.summary,
    ...companions.map((companion) => `stopped ${companion.label} ${companion.pid}`),
  ].join('; ');
  // A platform whose dev server serves several targets has no one truthful
  // relaunch, so the hint is optional.
  const next = surface.devServer.afterStop?.(target);
  const userAction = `${harnessHost().name} status --target ${shellQuote(target)} --json`;
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'stop',
          adapter,
          target,
          status: stop.status === 0 ? 'pass' : 'fail',
          ...(stop.signalled !== undefined || companions.length > 0 ? { signalled } : {}),
          exitCode: stop.status,
          ...(stop.output ? { output: stop.output } : {}),
          ...(stop.status === 0
            ? next
              ? { next }
              : {}
            : { error: { code: 'DEV_SERVER_STOP_FAILED', message: summary, userAction } }),
        },
        null,
        2,
      ),
    );
  } else {
    if (stop.output) process.stderr.write(`${stop.output}\n`);
    console.error(
      `${color(stop.status === 0 ? 'ok' : 'err', stop.status === 0 ? '✓' : '✗')} ${summary}`,
    );
    if (stop.status !== 0 || next)
      console.error(`  Next: ${stop.status === 0 ? next : userAction}`);
  }
  return stop.status;
}
