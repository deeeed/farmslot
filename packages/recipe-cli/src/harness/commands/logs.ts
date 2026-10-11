import fs from 'node:fs';
import path from 'node:path';

import { harnessAdapter } from '../adapters.js';
import {
  optionFlag,
  optionString,
  type ParsedArgs,
  resolveAdapter,
  usageError,
} from '../parse-args.js';
import { EXIT, spawnScriptStreaming, usageOut } from '../shared.js';

/** Read only the selected runtime's declared logs; followers use owned-child cancellation. */
export async function handleLogs({ options }: ParsedArgs): Promise<number> {
  const { adapter, target } = resolveAdapter(options);
  const runtime = harnessAdapter(adapter);
  const sources = runtime.logSources(target);
  const app = runtime.appLogSource(target);
  const requested = optionString(options, 'source');
  const sourceName =
    requested ?? (app && app.label !== 'app' ? app.label : (sources[0]?.label ?? app?.label));
  const isAppSource = app && (sourceName === 'app' || sourceName === app.label);
  const source = isAppSource ? app : sources.find((entry) => entry.label === sourceName);
  const labels = [
    ...new Set([...sources.map((entry) => entry.label), ...(app ? [app.label, 'app'] : [])]),
  ];
  const json = optionFlag(options, 'json');
  if (!source) {
    return usageOut(
      json,
      'logs',
      requested
        ? `Unknown log source ${requested}. Available: ${labels.join(', ') || 'none'}.`
        : `Runtime ${adapter} declares no logs for this target.`,
      runtime.hints.launch,
    );
  }
  if (!fs.existsSync(source.path)) {
    if (isAppSource) {
      const message = `application console unavailable for this checkout (${path.basename(source.path)} is absent).`;
      if (json) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: 'logs',
              adapter,
              target,
              source: sourceName,
              status: 'fail',
              error: { code: 'APP_LOG_UNAVAILABLE', message, userAction: runtime.hints.launch },
              exitCode: EXIT.runtime,
            },
            null,
            2,
          ),
        );
      } else {
        console.error(`logs: ${message}\n  Next: ${runtime.hints.launch}`);
      }
      return EXIT.runtime;
    }
    return usageOut(json, 'logs', `Log file is unavailable: ${source.path}`, runtime.hints.launch);
  }
  const lines = optionString(options, 'lines') ?? '20';
  if (!/^\d+$/u.test(lines) || !Number.isSafeInteger(Number(lines))) {
    throw usageError('--lines must be a nonnegative integer.');
  }
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'logs',
          adapter,
          target,
          source: sourceName,
          logFile: source.path,
          exitCode: EXIT.ok,
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  const result = await spawnScriptStreaming(
    'tail',
    [
      '-n',
      optionFlag(options, 'full') ? '+1' : lines,
      ...(optionFlag(options, 'full') || optionFlag(options, 'follow') ? ['-F'] : []),
      source.path,
    ],
    target,
    { forward: 'original', capture: false },
  );
  return result.status === 0 ? EXIT.ok : EXIT.runtime;
}
