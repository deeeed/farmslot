import fs from 'node:fs';
import path from 'node:path';

import { harnessAdapter } from '../adapters.js';
import { recipeExecutionSignal } from '../host.js';
import {
  optionFlag,
  optionString,
  type ParsedArgs,
  resolveAdapter,
  usageError,
} from '../parse-args.js';
import { EXIT, spawnScriptStreaming, usageOut } from '../shared.js';

export interface LogsViewRequest {
  target: string;
  logFile: string;
  events: string;
  mode: string;
  signal?: AbortSignal;
}

export interface LogsWindowRequest {
  target: string;
  logFile: string;
  signal?: AbortSignal;
}

export interface LogsWindowResult {
  window: string;
  logFile: string;
  exitCode: number;
}

export interface LogsCommandOptions {
  compact?(request: LogsViewRequest): Promise<number>;
  window?(request: LogsWindowRequest): Promise<LogsWindowResult>;
}

/** Read only the selected runtime's declared logs; followers use owned-child cancellation. */
export async function handleLogs(
  { options }: ParsedArgs,
  config: LogsCommandOptions = {},
): Promise<number> {
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
  const events = optionString(options, 'events');
  if (events !== undefined && !/^\d+$/u.test(events)) {
    throw usageError('--events must be numeric.');
  }
  const full = optionFlag(options, 'full');
  const raw = optionString(options, 'lines') !== undefined || optionFlag(options, 'follow');
  if (!full && events !== undefined && raw) {
    throw usageError('--events cannot be combined with --lines or --follow.');
  }
  const signal = recipeExecutionSignal();
  if (optionFlag(options, 'window')) {
    const primary = sources[0];
    if (!config.window || !primary || !fs.existsSync(primary.path)) {
      return usageOut(json, 'logs', 'The primary log window is unavailable.', runtime.hints.launch);
    }
    const result = await config.window({ target, logFile: primary.path, signal });
    if (json) {
      console.log(
        JSON.stringify(
          { schemaVersion: 1, command: 'logs', action: 'window', adapter, ...result },
          null,
          2,
        ),
      );
    }
    return result.exitCode;
  }
  if (!full && events !== undefined && !config.compact) {
    return usageOut(
      json,
      'logs',
      'This runtime does not support compact events.',
      runtime.hints.launch,
    );
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
  if (!full && !raw && config.compact) {
    return config.compact({
      target,
      logFile: source.path,
      events: events ?? process.env.RECIPE_LOG_EVENTS ?? '20',
      mode: process.env.RECIPE_LOG_UI_MODE ?? 'compact',
      signal,
    });
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
