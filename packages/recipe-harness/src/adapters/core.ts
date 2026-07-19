import { spawn } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { RecipeArtifactManifestEntry } from '@farmslot/protocol';

import {
  asNumber,
  asOptionalString,
  asString,
  getJsonPathValue,
  normalizeRelativePath,
} from '../core/json.js';
import { copyFileWithinRoots, readFileWithinRoot, statFileWithinRoot } from '../core/path.js';
import type { ActionAdapter } from '../core/types.js';

export function createStandardCoreAdapters(
  options: { actions?: Iterable<string> } = {},
): ActionAdapter[] {
  const adapters = [
    defineEndAdapter(),
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
      name: '@farmslot/recipe-harness',
    },
  }));
  if (!options.actions) return bundled;
  const actions = new Set(options.actions);
  return bundled.filter((adapter) => actions.has(adapter.action));
}

function defineEndAdapter(): ActionAdapter {
  return {
    action: 'end',
    async execute(node) {
      const rawStatus = node.status ?? 'unknown';
      if (rawStatus !== 'pass' && rawStatus !== 'fail' && rawStatus !== 'unknown') {
        throw new Error('end.status must be pass, fail, or unknown.');
      }
      return { status: rawStatus };
    },
  };
}

function defineWaitAdapter(): ActionAdapter {
  return {
    action: 'wait',
    async execute(node) {
      const durationMs = node.duration_ms ?? node.ms;
      const duration = asNumber(durationMs, 'wait.duration_ms');
      if (!Number.isInteger(duration) || duration < 0 || duration > 60_000) {
        throw new Error('wait.duration_ms must be an integer from 0 through 60000.');
      }
      await new Promise((resolve) => setTimeout(resolve, duration));
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
        if (!content.includes(expected)) {
          throw new Error(
            `File ${filePath} does not contain expected text ${JSON.stringify(expected)}.`,
          );
        }
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
          throw new Error(`${source}.${stream} does not contain ${JSON.stringify(expected)}.`);
        }
        return { output: { source, stream, contains: expected } };
      }
      if (node.match != null) {
        const pattern = asString(node.match, 'assert_output.match');
        if (!new RegExp(pattern).test(actual)) {
          throw new Error(`${source}.${stream} does not match ${pattern}.`);
        }
        return { output: { source, stream, match: pattern } };
      }
      const assertion = parseAssertion(node.assert, 'assert_output.assert');
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
    async execute(node, context) {
      if (!Array.isArray(node.cases)) {
        throw new Error('switch.cases must be an array of { when, next } entries.');
      }
      for (const [index, rawCase] of node.cases.entries()) {
        if (!rawCase || typeof rawCase !== 'object' || Array.isArray(rawCase)) {
          throw new Error(`switch.cases[${index}] must be an object.`);
        }
        const switchCase = rawCase as Record<string, unknown>;
        const next = asString(switchCase.next, `switch.cases[${index}].next`);
        const predicate = parseAssertionNode(switchCase.when, `switch.cases[${index}].when`);
        if (evaluateAssertion(context.outputs, predicate)) {
          return { next, output: { case: index, next } };
        }
      }
      const defaultNext = asOptionalString(node.default, 'switch.default');
      if (!defaultNext) throw new Error('switch did not match any case and has no default.');
      return { next: defaultNext, output: { case: 'default', next: defaultNext } };
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
      const contentBuffer = await readFileWithinRoot(context.projectRoot, filePath);
      const baseline = rawScope === 'file' ? 0 : (context.getRunFileOffset(filePath) ?? 0);
      const start = baseline > contentBuffer.length ? 0 : baseline;
      const content = contentBuffer.subarray(start).toString('utf-8');
      if (contains && !content.includes(contains)) {
        throw new Error(
          `Log ${filePath} does not contain ${JSON.stringify(contains)} in ${rawScope} scope.`,
        );
      }
      return {
        output: {
          path: filePath,
          matched: contains ?? null,
          scope: rawScope,
          offset: start,
          bytesScanned: contentBuffer.length - start,
        },
      };
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

function runShellCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`));
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

interface ParsedAssertion {
  path: string;
  operator: string;
  value: unknown;
}

type AssertionNode =
  | ParsedAssertion
  | { all: AssertionNode[] }
  | { any: AssertionNode[] }
  | { none: AssertionNode[] };

function parseAssertion(value: unknown, label: string): ParsedAssertion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  return {
    path: asOptionalString(record.path, `${label}.path`) ?? '$',
    operator: asString(record.operator, `${label}.operator`),
    value: record.value,
  };
}

function parseAssertionNode(value: unknown, label: string): AssertionNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of ['all', 'any', 'none'] as const) {
    if (record[key] == null) continue;
    const entries = record[key];
    if (!Array.isArray(entries)) throw new Error(`${label}.${key} must be an array.`);
    const assertions = entries.map((entry, index) =>
      parseAssertionNode(entry, `${label}.${key}[${index}]`),
    );
    if (key === 'all') return { all: assertions };
    if (key === 'any') return { any: assertions };
    return { none: assertions };
  }
  return parseAssertion(value, label);
}

function assertAssertion(actualRoot: unknown, assertion: AssertionNode, label: string): void {
  if (!evaluateAssertion(actualRoot, assertion)) {
    throw new Error(`${label} failed assertion ${JSON.stringify(assertion)}.`);
  }
}

function evaluateAssertion(actualRoot: unknown, assertion: AssertionNode): boolean {
  if ('all' in assertion)
    return assertion.all.every((entry) => evaluateAssertion(actualRoot, entry));
  if ('any' in assertion)
    return assertion.any.some((entry) => evaluateAssertion(actualRoot, entry));
  if ('none' in assertion)
    return !assertion.none.some((entry) => evaluateAssertion(actualRoot, entry));
  const actual = assertion.path === '$' ? actualRoot : getJsonPathValue(actualRoot, assertion.path);
  return evaluateAtomicValue(actual, assertion.operator, assertion.value);
}

function assertAtomicValue(
  actual: unknown,
  operator: string,
  expected: unknown,
  label: string,
): void {
  if (!evaluateAtomicValue(actual, operator, expected)) {
    throw new Error(
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
