import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import type { RecipeArtifactManifestEntry } from '@farmslot/protocol';

import { type AssertionNode, parseAssertionNode } from '../core/assertions.js';
import { assertRecipeActive, recipeAbortError, RecipeExecutionError } from '../core/failure.js';
import {
  asNumber,
  asOptionalString,
  asString,
  getJsonPathValue,
  isRecord,
  normalizeRelativePath,
} from '../core/json.js';
import { copyFileWithinRoots, readFileWithinRoot, statFileWithinRoot } from '../core/path.js';
import type { ActionAdapter, ActionExecutionContext } from '../core/types.js';

export { recipeExecutionSignal, withRecipeExecutionSignal } from '../core/execution-signal.js';
export { assertRecipeActive } from '../core/failure.js';

export const RECIPE_PROCESS_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

export function createStandardCoreAdapters(
  options: { actions?: Iterable<string> } = {},
): ActionAdapter[] {
  const adapters = [
    defineWaitAdapter(),
    defineCommandAdapter(),
    defineAssertFileAdapter(),
    defineAssertJsonAdapter(),
    defineAssertExitCodeAdapter(),
    defineAssertOutputAdapter(),
    defineWatchLogsAdapter(),
    defineIndexArtifactsAdapter(),
    defineStateReadAdapter(),
    defineSwitchAdapter(),
    defineManualAdapter(),
  ];
  const bundled = adapters.map((adapter) => ({
    ...adapter,
    source: {
      kind: 'bundled' as const,
      trust: 'trusted' as const,
      name: '@farmslot/recipe-runner',
    },
  }));
  if (!options.actions) return bundled;
  const actions = new Set(options.actions);
  return bundled.filter((adapter) => actions.has(adapter.action));
}

function defineWaitAdapter(): ActionAdapter {
  return {
    action: 'wait',
    async execute(node, context) {
      const durationMs = node.duration_ms ?? node.ms;
      const duration = asNumber(durationMs, 'wait.duration_ms');
      if (!Number.isInteger(duration) || duration < 0 || duration > 60_000) {
        throw new Error('wait.duration_ms must be an integer from 0 through 60000.');
      }
      await delay(duration, undefined, { signal: context.signal });
      return { output: { durationMs: duration } };
    },
  };
}

function defineCommandAdapter(): ActionAdapter {
  return {
    action: 'command',
    async execute(node, context) {
      const command = asString(node.cmd ?? node.command, 'command.cmd');
      const cwd = asOptionalString(node.cwd, 'command.cwd');
      const timeoutMs =
        node.timeout_ms == null ? undefined : asNumber(node.timeout_ms, 'command.timeout_ms');
      const result = await runShellCommand(command, {
        cwd: cwd ? context.resolveProjectPath(cwd) : context.projectRoot,
        env: context.env,
        timeoutMs,
        signal: context.signal,
      });
      if (node.allow_failure !== true && result.exitCode !== 0) {
        throw new Error(`Command exited with ${result.exitCode}: ${command}\n${result.stderr}`);
      }
      return { output: result };
    },
  };
}

function defineAssertFileAdapter(): ActionAdapter {
  return {
    action: 'assert_file',
    async execute(node, context) {
      const filePath = asString(node.path, 'assert_file.path');
      const stats = await statFileWithinRoot(context.projectRoot, filePath);
      if (node.contains != null) {
        const content = (await readFileWithinRoot(context.projectRoot, filePath)).toString('utf-8');
        const expected = asString(node.contains, 'assert_file.contains');
        const observation = {
          path: filePath,
          sizeBytes: stats.size,
          contains: expected,
          matched: content.includes(expected),
        };
        if (!observation.matched) {
          throw new RecipeExecutionError(
            'subject',
            `File ${filePath} does not contain expected text ${JSON.stringify(expected)}.`,
            { code: 'FILE_CONTENT_MISMATCH', details: observation },
          );
        }
        return { output: observation };
      }
      return { output: { path: filePath, sizeBytes: stats.size } };
    },
  };
}

function defineAssertJsonAdapter(): ActionAdapter {
  return {
    action: 'assert_json',
    async execute(node, context) {
      const filePath = asString(node.path, 'assert_json.path');
      const content = (await readFileWithinRoot(context.projectRoot, filePath)).toString('utf-8');
      const document: unknown = JSON.parse(content);
      const assertion = parseAssertionNode(node.assert, 'assert_json.assert');
      assertAssertion(document, assertion, `JSON ${filePath}`);
      return { output: { path: filePath, assertion } };
    },
  };
}

function defineAssertExitCodeAdapter(): ActionAdapter {
  return {
    action: 'assert_exit_code',
    async execute(node, context) {
      const source = asString(node.source ?? node.node, 'assert_exit_code.source');
      const expected =
        node.expected == null ? 0 : asNumber(node.expected, 'assert_exit_code.expected');
      const output = context.getOutput(source);
      const actual = getOutputField(output, 'exitCode');
      assertAtomicValue(actual, 'eq', expected, `${source}.exitCode`);
      return { output: { source, expected, actual } };
    },
  };
}

function defineAssertOutputAdapter(): ActionAdapter {
  return {
    action: 'assert_output',
    async execute(node, context) {
      const source = asString(node.source ?? node.node, 'assert_output.source');
      const stream = asOptionalString(node.stream, 'assert_output.stream') ?? 'stdout';
      const output = context.getOutput(source);
      const actual = String(getOutputField(output, stream) ?? '');
      if (node.contains != null) {
        const expected = asString(node.contains, 'assert_output.contains');
        if (!actual.includes(expected)) {
          throw new RecipeExecutionError(
            'subject',
            `${source}.${stream} does not contain ${JSON.stringify(expected)}.`,
          );
        }
        return { output: { source, stream, contains: expected } };
      }
      if (node.match != null) {
        const pattern = asString(node.match, 'assert_output.match');
        if (!new RegExp(pattern).test(actual)) {
          throw new RecipeExecutionError(
            'subject',
            `${source}.${stream} does not match ${pattern}.`,
          );
        }
        return { output: { source, stream, match: pattern } };
      }
      const assertion = parseAssertionNode(node.assert, 'assert_output.assert');
      if (!('path' in assertion)) {
        assertAssertion(output, assertion, source, actual);
        return { output: { source, stream, assertion } };
      }
      const selected = assertion.path === '$' ? actual : getJsonPathValue(output, assertion.path);
      assertAtomicValue(
        selected,
        assertion.operator,
        assertion.value,
        `${source}.${assertion.path}`,
      );
      return { output: { source, stream, assertion: { ...assertion, actual: selected } } };
    },
  };
}

function defineStateReadAdapter(): ActionAdapter {
  return {
    action: 'state_read',
    async execute(node, context) {
      const source = asString(node.source ?? node.node, 'state_read.source');
      const output = context.getOutput(source);
      const statePath = asOptionalString(node.path, 'state_read.path') ?? '$';
      const value = statePath === '$' ? output : getJsonPathValue(output, statePath);
      return { output: { source, path: statePath, value } };
    },
  };
}

function defineSwitchAdapter(): ActionAdapter {
  return {
    action: 'switch',
    async execute(node) {
      const value = asString(node.value, 'switch.value');
      const expected = asString(node.equals, 'switch.equals');
      const matched = value === expected;
      return {
        ...(matched ? { case: 'match' } : {}),
        output: { matched, value, expected },
      };
    },
  };
}

function defineManualAdapter(): ActionAdapter {
  return {
    action: 'manual',
    async execute(node) {
      return {
        output: {
          manual: true,
          instruction: asOptionalString(node.instruction ?? node.description, 'manual.instruction'),
        },
      };
    },
  };
}

function defineWatchLogsAdapter(): ActionAdapter {
  return {
    action: 'watch_logs',
    async execute(node, context) {
      const filePath = asString(node.path, 'watch_logs.path');
      const contains = asOptionalString(node.contains, 'watch_logs.contains');
      const rawScope = asOptionalString(node.scope, 'watch_logs.scope') ?? 'run';
      if (rawScope !== 'run' && rawScope !== 'file') {
        throw new Error('watch_logs.scope must be "run" or "file".');
      }
      const timeoutMs =
        node.timeout_ms === undefined ? 0 : asNumber(node.timeout_ms, 'watch_logs.timeout_ms');
      const baseline = rawScope === 'file' ? 0 : context.getRunFileOffset(filePath);
      if (baseline === undefined) {
        throw new Error(`Run-scoped log ${filePath} has no captured baseline.`);
      }
      let start = baseline;
      const deadline = performance.now() + timeoutMs;
      do {
        assertRecipeActive(context.signal);
        let contentBuffer: Buffer | undefined;
        try {
          contentBuffer = await readFileWithinRoot(context.projectRoot, filePath);
        } catch (error) {
          // A producer may create its log during the declared observation window.
          if (timeoutMs === 0 || !isRecord(error) || error.code !== 'ENOENT') throw error;
        }
        assertRecipeActive(context.signal);
        if (contentBuffer) {
          if (start > contentBuffer.length) start = 0;
          const content = contentBuffer.subarray(start).toString('utf-8');
          if (!contains || content.includes(contains)) {
            return {
              output: {
                path: filePath,
                matched: contains ?? null,
                scope: rawScope,
                offset: start,
                bytesScanned: contentBuffer.length - start,
              },
            };
          }
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        try {
          await delay(Math.min(100, remaining), undefined, { signal: context.signal });
        } catch (error) {
          assertRecipeActive(context.signal);
          throw error;
        }
      } while (performance.now() < deadline);
      throw new RecipeExecutionError(
        'subject',
        `Log ${filePath} does not contain ${JSON.stringify(contains)} in ${rawScope} scope.`,
      );
    },
  };
}

function defineIndexArtifactsAdapter(): ActionAdapter {
  return {
    action: 'index_artifacts',
    async execute(node, context) {
      if (!Array.isArray(node.artifacts)) {
        throw new Error('index_artifacts.artifacts must be an array of relative paths or entries.');
      }
      const entries: RecipeArtifactManifestEntry[] = [];
      for (const artifact of node.artifacts) {
        const entry = parseArtifactEntry(artifact, context.nodeId);
        await copyFileWithinRoots(
          context.projectRoot,
          entry.path,
          context.artifactsDir,
          entry.path,
        );
        context.registerArtifact(entry);
        entries.push(entry);
      }
      return { artifacts: entries, output: { artifacts: entries.map((entry) => entry.path) } };
    },
  };
}

function parseArtifactEntry(value: unknown, nodeId: string): RecipeArtifactManifestEntry {
  if (typeof value === 'string') {
    const artifactPath = normalizeRelativePath(value).split(path.sep).join('/');
    return { path: artifactPath, type: inferArtifactType(artifactPath), nodeId };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Artifact entries must be strings or objects.');
  }
  const record = value as Record<string, unknown>;
  const artifactPath = normalizeRelativePath(asString(record.path, 'artifact.path'))
    .split(path.sep)
    .join('/');
  return {
    path: artifactPath,
    type: asOptionalString(record.type, 'artifact.type') ?? inferArtifactType(artifactPath),
    label: asOptionalString(record.label, 'artifact.label'),
    nodeId: asOptionalString(record.nodeId, 'artifact.nodeId') ?? nodeId,
    mimeType: asOptionalString(record.mimeType, 'artifact.mimeType'),
    category: asOptionalString(record.category, 'artifact.category'),
    proofTarget: asOptionalString(record.proofTarget, 'artifact.proofTarget'),
    covers: Array.isArray(record.covers)
      ? record.covers.map((cover) => asString(cover, 'artifact.covers[]'))
      : undefined,
  };
}

function inferArtifactType(artifactPath: string): RecipeArtifactManifestEntry['type'] {
  if (/\.(png|jpg|jpeg|gif|webp)$/i.test(artifactPath)) return 'screenshot';
  if (/\.(mp4|mov|webm)$/i.test(artifactPath)) return 'video';
  if (/\.log$/i.test(artifactPath)) return 'log';
  if (/\.json$/i.test(artifactPath)) return 'json';
  if (/\.(md|html)$/i.test(artifactPath)) return 'report';
  return 'other';
}

interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RecipeProcessOptions {
  cwd: string;
  env?: ActionExecutionContext['env'];
  shell?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  ownProcessGroup?: boolean;
  stdin?: 'ignore' | 'inherit';
  input?: string;
  capture?: boolean;
  onOutput?(chunk: Uint8Array, stream: 'stdout' | 'stderr'): void;
  onSpawnError?(error: RecipeProcessError): void;
  onSpawn?(pid: number, ownsProcessGroup: boolean): (() => void) | undefined;
}

export interface RecipeProcessError extends Error {
  code?: string;
}

export interface RecipeProcessResult extends CommandOutput {
  signal: string | null;
  timedOut: boolean;
}

/** Own the spawned group through cancellation/timeout; normal exits may retain background services. */
export function runOwnedRecipeProcess(
  command: string,
  args: string[],
  options: RecipeProcessOptions,
): Promise<RecipeProcessResult> {
  return new Promise((resolve, reject) => {
    assertRecipeActive(options.signal);
    const ownsProcessGroup = options.ownProcessGroup !== false && process.platform !== 'win32';
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      stdio: [options.input === undefined ? (options.stdin ?? 'ignore') : 'pipe', 'pipe', 'pipe'],
      detached: ownsProcessGroup,
    });
    let timedOut = false;
    let stopping = false;
    let settled = false;
    let leafExited = false;
    let groupKilled = false;
    let failure: unknown;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let untrack: (() => void) | undefined;
    const output = { stdout: '', stderr: '' };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const signalTree = (signal: NodeJS.Signals): void => {
      try {
        if (ownsProcessGroup && child.pid) {
          process.kill(-child.pid, signal);
          if (signal === 'SIGKILL') groupKilled = true;
        } else child.kill(signal);
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        // A reaped group is absent; macOS also refuses signals to zombie-only groups.
        if (code !== 'ESRCH' && !(code === 'EPERM' && (groupKilled || leafExited))) {
          failure ??= error;
        }
      }
    };
    const finishStopping = (): void => {
      signalTree('SIGKILL');
      // Foreground callers cannot kill the shared group. Descendants must not
      // hold this timed-out invocation open through inherited output pipes.
      if (!ownsProcessGroup) {
        child.stdout!.destroy();
        child.stderr!.destroy();
      }
    };
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping || settled) return;
      stopping = true;
      signalTree(signal);
      if (leafExited) finishStopping();
      else escalation = setTimeout(finishStopping, 1000);
    };
    const abort = (): void => {
      const reason: unknown = options.signal?.reason;
      stop(
        RECIPE_PROCESS_SIGNALS.some((name) => name === reason)
          ? (reason as NodeJS.Signals)
          : 'SIGTERM',
      );
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      failure ??= error;
      options.onSpawnError?.(error);
      stop('SIGKILL');
    });
    child.once('exit', () => {
      leafExited = true;
      // A shell may exit while a descendant still holds the output pipe open.
      if (stopping) finishStopping();
    });
    child.once('close', (code, signal) => {
      if (stopping) signalTree('SIGKILL');
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      if (code !== null) untrack?.();
      for (const stream of ['stdout', 'stderr'] as const) {
        if (options.capture !== false) output[stream] += decoders[stream].end();
      }
      if (failure !== undefined) reject(failure);
      else if (options.signal?.aborted) reject(recipeAbortError(options.signal));
      else resolve({ exitCode: code ?? 1, signal, ...output, timedOut });
    });
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]!.on('data', (chunk: Buffer) => {
        if (options.capture !== false) output[stream] += decoders[stream].write(chunk);
        try {
          options.onOutput?.(chunk, stream);
        } catch (error) {
          failure ??= error;
          stop('SIGKILL');
        }
      });
    }
    if (child.pid) {
      try {
        untrack = options.onSpawn?.(child.pid, ownsProcessGroup);
      } catch (error) {
        failure ??= error;
        stop('SIGKILL');
      }
    }
    if (options.input !== undefined) {
      child.stdin!.on('error', (error: NodeJS.ErrnoException) => {
        // Early stdin closure is represented by the child's exit result; a settled run is final.
        if (error.code === 'EPIPE' || settled) return;
        failure ??= error;
        stop('SIGKILL');
      });
      child.stdin!.end(options.input);
    }
    if (Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stop('SIGTERM');
      }, options.timeoutMs);
    }
    // The owner callback may have cancelled before it returned.
    if (options.signal?.aborted) abort();
  });
}

async function runShellCommand(
  command: string,
  options: RecipeProcessOptions,
): Promise<CommandOutput> {
  const result = await runOwnedRecipeProcess(command, [], {
    ...options,
    shell: true,
    // Legacy hosts without signal transport still rely on their foreground process group.
    ownProcessGroup: options.signal !== undefined,
  });
  if (result.timedOut)
    throw new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function assertAssertion(
  actualRoot: unknown,
  assertion: AssertionNode,
  label: string,
  rootValue: unknown = actualRoot,
): void {
  if (!evaluateAssertion(actualRoot, assertion, rootValue)) {
    throw new RecipeExecutionError(
      'subject',
      `${label} failed assertion ${JSON.stringify(assertion)}.`,
    );
  }
}

function evaluateAssertion(
  actualRoot: unknown,
  assertion: AssertionNode,
  rootValue: unknown = actualRoot,
): boolean {
  if ('all' in assertion)
    return assertion.all.every((entry) => evaluateAssertion(actualRoot, entry, rootValue));
  if ('any' in assertion)
    return assertion.any.some((entry) => evaluateAssertion(actualRoot, entry, rootValue));
  if ('none' in assertion)
    return !assertion.none.some((entry) => evaluateAssertion(actualRoot, entry, rootValue));
  const actual = assertion.path === '$' ? rootValue : getJsonPathValue(actualRoot, assertion.path);
  return evaluateAtomicValue(actual, assertion.operator, assertion.value);
}

function assertAtomicValue(
  actual: unknown,
  operator: string,
  expected: unknown,
  label: string,
): void {
  if (!evaluateAtomicValue(actual, operator, expected)) {
    throw new RecipeExecutionError(
      'subject',
      `${label} expected ${operator} ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function evaluateAtomicValue(actual: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    case 'exists':
      return actual !== undefined;
    case 'not_null':
      return actual != null;
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    case 'eq':
      return actual === expected;
    case 'ne':
    case 'neq':
      return actual !== expected;
    case 'deep_eq':
      return isDeepStrictEqual(actual, expected);
    case 'contains':
      return containsValue(actual, expected);
    case 'not_contains':
      return !containsValue(actual, expected);
    case 'matches':
      return typeof expected === 'string' && new RegExp(expected).test(String(actual ?? ''));
    case 'one_of':
      return Array.isArray(expected) && expected.some((entry) => isDeepStrictEqual(entry, actual));
    case 'length_eq':
      return getLength(actual) === expected;
    case 'length_gt':
      return typeof expected === 'number' && getLength(actual) > expected;
    case 'length_gte':
      return typeof expected === 'number' && getLength(actual) >= expected;
    case 'length_lt':
      return typeof expected === 'number' && getLength(actual) < expected;
    case 'length_lte':
      return typeof expected === 'number' && getLength(actual) <= expected;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof expected !== 'number') {
        return false;
      }
      if (operator === 'gt') return actual > expected;
      if (operator === 'gte') return actual >= expected;
      if (operator === 'lt') return actual < expected;
      return actual <= expected;
    }
    default:
      throw new Error(`Unsupported assertion operator ${operator}.`);
  }
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(String(expected));
  if (Array.isArray(actual)) return actual.some((entry) => isDeepStrictEqual(entry, expected));
  return false;
}

function getLength(actual: unknown): number {
  if (typeof actual === 'string' || Array.isArray(actual)) return actual.length;
  if (actual && typeof actual === 'object') return Object.keys(actual).length;
  return Number.NaN;
}

function getOutputField(output: unknown, field: string): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  return (output as Record<string, unknown>)[field];
}
