import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { asNumber, asOptionalString } from '../core/json.js';
import type { ActionAdapter, ActionExecutionContext } from '../core/types.js';

const execFileAsync = promisify(execFile);

export type AppLifecyclePlatform = 'android' | 'ios-simulator';

export type AppLifecycleCommand = 'launch' | 'foreground' | 'background' | 'terminate' | 'restart';

export interface AppLifecycleTarget {
  platform: AppLifecyclePlatform;
  /** Android adb serial or iOS simulator UDID/name. */
  deviceId?: string;
  /** Android package name or iOS bundle id. */
  appId: string;
  /** Optional deep link used for Expo/dev-client launch and foreground. */
  launchUrl?: string;
  /** Optional Metro port to reverse on Android before opening Expo/dev-client. */
  metroPort?: string | number;
  /** Optional host-side calls to run immediately before launch/foreground. */
  prelaunchCalls?: AppLifecycleCall[];
}

export interface AppLifecycleExecResult {
  stdout?: string;
  stderr?: string;
}

export interface AppLifecycleCommandRunner {
  execFile(
    file: string,
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<AppLifecycleExecResult>;
}

export interface AppLifecycleCall {
  file: string;
  args: string[];
  ignoreFailureWhenOutputIncludes?: string[];
}

export interface AppLifecycleTargetProvider {
  resolveTarget(
    node: Record<string, unknown>,
    context: ActionExecutionContext,
  ): Promise<AppLifecycleTarget> | AppLifecycleTarget;
}

export interface CreateAppLifecycleAdapterOptions {
  actions?: Iterable<string>;
  targetProvider: AppLifecycleTargetProvider;
  commandRunner?: AppLifecycleCommandRunner;
}

export function createAppLifecycleAdapters(
  options: CreateAppLifecycleAdapterOptions,
): ActionAdapter[] {
  if (options.actions && !new Set(options.actions).has('app.lifecycle')) return [];
  return [createAppLifecycleAdapter(options)];
}

export function createAppLifecycleAdapter(
  options: CreateAppLifecycleAdapterOptions,
): ActionAdapter {
  const commandRunner = options.commandRunner ?? defaultCommandRunner();
  return {
    action: 'app.lifecycle',
    async execute(node, context) {
      // Validate every node input before resolving the target or running any
      // command, so a bad knob can never fail the action after side effects.
      const command = parseLifecycleCommand(node);
      const timeoutMs = optionalIntegerInRange(
        node.timeout_ms,
        'app.lifecycle.timeout_ms',
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const settleMs = optionalIntegerInRange(node.settle_ms, 'app.lifecycle.settle_ms', 0, 60_000);
      const target = await options.targetProvider.resolveTarget(node, context);
      const calls = lifecycleCalls(command, target);
      const results = [];
      for (const call of calls) {
        const result = await execLifecycleCall(commandRunner, call, timeoutMs);
        results.push({
          file: call.file,
          args: call.args,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          ignoredFailure: result.ignoredFailure ?? false,
        });
      }
      if (settleMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
      return {
        output: {
          command,
          platform: target.platform,
          deviceId: target.deviceId ?? null,
          appId: target.appId,
          launchUrl: target.launchUrl ?? null,
          calls: results,
          settleMs: settleMs ?? 0,
        },
      };
    },
  };
}

function parseLifecycleCommand(node: Record<string, unknown>): AppLifecycleCommand {
  // `event` and `state` are accepted as aliases for `command` so recipes can use
  // the field name that reads best for their flow (e.g. state: background).
  const raw =
    asOptionalString(node.command, 'app.lifecycle.command') ??
    asOptionalString(node.event, 'app.lifecycle.event') ??
    asOptionalString(node.state, 'app.lifecycle.state');
  if (!raw) {
    throw new Error(
      'app.lifecycle.command must be explicit (aliases: event, state). Supported commands: launch, foreground, background, terminate, restart.',
    );
  }
  const command = raw;
  if (
    command === 'launch' ||
    command === 'foreground' ||
    command === 'background' ||
    command === 'terminate' ||
    command === 'restart'
  ) {
    return command;
  }
  throw new Error(
    `Unsupported app.lifecycle command: ${command}. Supported commands: launch, foreground, background, terminate, restart.`,
  );
}

function lifecycleCalls(
  command: AppLifecycleCommand,
  target: AppLifecycleTarget,
): AppLifecycleCall[] {
  if (!target.appId || !target.appId.trim()) {
    throw new Error('app.lifecycle target requires appId.');
  }
  if (command === 'restart') {
    return [
      ...lifecycleCalls('terminate', target),
      ...(target.prelaunchCalls ?? []),
      ...lifecycleCalls('launch', target),
    ];
  }
  if (command === 'launch' || command === 'foreground') {
    return [...(target.prelaunchCalls ?? []), ...lifecyclePlatformCalls(command, target)];
  }
  return lifecyclePlatformCalls(command, target);
}

function lifecyclePlatformCalls(
  command: Exclude<AppLifecycleCommand, 'restart'>,
  target: AppLifecycleTarget,
): AppLifecycleCall[] {
  if (target.platform === 'android') return androidLifecycleCalls(command, target);
  if (target.platform === 'ios-simulator') return iosSimulatorLifecycleCalls(command, target);
  throw new Error(`Unsupported app.lifecycle platform: ${String(target.platform)}`);
}

function androidLifecycleCalls(
  command: Exclude<AppLifecycleCommand, 'restart'>,
  target: AppLifecycleTarget,
): AppLifecycleCall[] {
  const adb = 'adb';
  const serialArgs = target.deviceId ? ['-s', target.deviceId] : [];
  if (command === 'background') {
    return [{ file: adb, args: [...serialArgs, 'shell', 'input', 'keyevent', 'HOME'] }];
  }
  if (command === 'terminate') {
    return [{ file: adb, args: [...serialArgs, 'shell', 'am', 'force-stop', target.appId] }];
  }
  if (target.launchUrl) {
    const calls: AppLifecycleCall[] = [];
    if (target.metroPort !== undefined && target.metroPort !== '') {
      const port = String(target.metroPort);
      calls.push({
        file: adb,
        args: [...serialArgs, 'reverse', `tcp:${port}`, `tcp:${port}`],
      });
    }
    calls.push({
      file: adb,
      args: [
        ...serialArgs,
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        target.launchUrl,
      ],
    });
    return calls;
  }
  return [
    {
      file: adb,
      args: [
        ...serialArgs,
        'shell',
        'monkey',
        '-p',
        target.appId,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ],
    },
  ];
}

function iosSimulatorLifecycleCalls(
  command: Exclude<AppLifecycleCommand, 'restart'>,
  target: AppLifecycleTarget,
): AppLifecycleCall[] {
  const device = target.deviceId ?? 'booted';
  if (command === 'background') {
    // iOS Simulator has no direct HOME equivalent; foreground Settings to background the app under test.
    return [{ file: 'xcrun', args: ['simctl', 'launch', device, 'com.apple.Preferences'] }];
  }
  if (command === 'terminate') {
    return [
      {
        file: 'xcrun',
        args: ['simctl', 'terminate', device, target.appId],
        // simctl terminate exits non-zero when the app is already stopped; restart should remain idempotent.
        ignoreFailureWhenOutputIncludes: ['not running'],
      },
    ];
  }
  if (target.launchUrl) {
    return [{ file: 'xcrun', args: ['simctl', 'openurl', device, target.launchUrl] }];
  }
  return [{ file: 'xcrun', args: ['simctl', 'launch', device, target.appId] }];
}

async function execLifecycleCall(
  commandRunner: AppLifecycleCommandRunner,
  call: AppLifecycleCall,
  timeoutMs: number | undefined,
): Promise<AppLifecycleExecResult & { ignoredFailure?: boolean }> {
  try {
    return await commandRunner.execFile(call.file, call.args, { timeoutMs });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (call.ignoreFailureWhenOutputIncludes?.some((needle) => text.includes(needle))) {
      return { stderr: text, ignoredFailure: true };
    }
    throw error;
  }
}

function optionalIntegerInRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value == null) return undefined;
  const number = asNumber(value, label);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  }
  return number;
}

function defaultCommandRunner(): AppLifecycleCommandRunner {
  return {
    async execFile(file, args, options) {
      try {
        return await execFileAsync(file, args, {
          timeout: options?.timeoutMs,
          encoding: 'utf8',
        });
      } catch (error) {
        if (error instanceof Error) {
          const output = error as Error & { stdout?: string; stderr?: string };
          const details = [output.message, output.stderr, output.stdout].filter(Boolean).join('\n');
          throw new Error(`${file} ${args.join(' ')} failed: ${details}`);
        }
        throw error;
      }
    },
  };
}
