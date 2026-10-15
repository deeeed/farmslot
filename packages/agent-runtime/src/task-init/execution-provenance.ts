import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  isRecord,
  type RecipeConformanceIdentity,
  type RecipeConformanceSource,
} from '@farmslot/protocol';

import { retainTaskInput, taskInputDigest } from './pin.js';

export type TaskRecipeBindingIdentity = Pick<
  RecipeConformanceIdentity,
  | 'project'
  | 'app'
  | 'domain'
  | 'adapter'
  | 'target'
  | 'provider'
  | 'implementation'
  | 'libraries'
  | 'configuration'
>;

export interface TaskRetainedInput {
  source: string;
  path: string;
  sha256: string;
}

export interface TaskExecutionProvenance {
  schemaVersion: 1;
  package: { name: string; version: string };
  source: { kind: string; packageRoot: string };
  resolvedExecutable: string;
  entrySha256: string;
  packageTreeSha256: string;
  recordedAt: string;
  bindingIdentity: TaskRecipeBindingIdentity | null;
  retainedInputs: TaskRetainedInput[];
}

export interface TaskExecutionInput {
  executable: string;
  packageRoot: string;
  distributionRoot: string;
  bindingIdentity: TaskRecipeBindingIdentity | null;
  /** All executable provider/library inputs and selected configuration bytes. */
  inputs: readonly string[];
  /** Host selection data. Its bytes are retained and verified with the tooling. */
  selectedConfiguration?: string;
}

export class TaskProvenanceError extends Error {
  readonly exitCode = 5;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskProvenanceError';
  }
}

const receiptFile = 'artifacts/harness-provenance.json';
const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function isRetainedInput(value: unknown): value is TaskRetainedInput {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.path === 'string' &&
    typeof value.sha256 === 'string'
  );
}

function isSource(value: unknown): value is RecipeConformanceSource {
  return (
    isRecord(value) &&
    (value.head === null || typeof value.head === 'string') &&
    typeof value.status === 'string' &&
    typeof value.sourceFingerprint === 'string' &&
    (value.dirtyDigest === undefined ||
      value.dirtyDigest === null ||
      typeof value.dirtyDigest === 'string')
  );
}

function isBindingIdentity(value: unknown): value is TaskRecipeBindingIdentity | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.project === 'string' &&
    typeof value.adapter === 'string' &&
    typeof value.target === 'string' &&
    (value.app === null || typeof value.app === 'string') &&
    (value.domain === null || typeof value.domain === 'string') &&
    isSource(value.provider) &&
    (value.implementation === undefined ||
      (Array.isArray(value.implementation) &&
        value.implementation.every(
          (entry) => isRecord(entry) && typeof entry.name === 'string' && isSource(entry),
        ))) &&
    Array.isArray(value.libraries) &&
    value.libraries.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        (entry.path === undefined || typeof entry.path === 'string') &&
        isSource(entry),
    ) &&
    Array.isArray(value.configuration) &&
    value.configuration.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === 'string' &&
        typeof entry.sourceFingerprint === 'string',
    )
  );
}

function isReceipt(value: unknown): value is TaskExecutionProvenance {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isRecord(value.package) &&
    typeof value.package.name === 'string' &&
    typeof value.package.version === 'string' &&
    isRecord(value.source) &&
    typeof value.source.kind === 'string' &&
    typeof value.source.packageRoot === 'string' &&
    typeof value.resolvedExecutable === 'string' &&
    typeof value.entrySha256 === 'string' &&
    typeof value.packageTreeSha256 === 'string' &&
    typeof value.recordedAt === 'string' &&
    isBindingIdentity(value.bindingIdentity) &&
    Array.isArray(value.retainedInputs) &&
    value.retainedInputs.length > 0 &&
    value.retainedInputs.every(isRetainedInput)
  );
}

/** Verify through the trusted installed runtime before invoking the recorded executable. */
export function verifyTaskExecutionProvenance(
  taskDir: string,
  expectedBindingIdentity: TaskRecipeBindingIdentity | null,
): TaskExecutionProvenance {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(taskDir, receiptFile), 'utf8'));
  if (isRecord(value) && !('bindingIdentity' in value)) {
    throw new TaskProvenanceError(
      'TASK_PROVENANCE_LEGACY',
      'This task retains a legacy receipt. Use its original pinned marker.',
    );
  }
  if (!isReceipt(value))
    throw new TaskProvenanceError(
      'TASK_PROVENANCE_INVALID',
      'The task execution receipt is invalid.',
    );
  const inputsRoot = fs.realpathSync(path.join(taskDir, 'inputs'));
  const within = (root: string, file: string): boolean =>
    file === root || file.startsWith(`${root}${path.sep}`);
  const distribution = fs.realpathSync(value.retainedInputs[0]!.path);
  if (
    value.package.name !== '@farmslot/cli' ||
    value.source.kind !== 'task-retained' ||
    !within(distribution, fs.realpathSync(value.source.packageRoot)) ||
    !within(distribution, fs.realpathSync(value.resolvedExecutable))
  ) {
    throw new TaskProvenanceError(
      'TASK_PROVENANCE_INVALID',
      'The task must retain its Farmslot CLI installation.',
    );
  }
  if (!isDeepStrictEqual(value.bindingIdentity, expectedBindingIdentity)) {
    throw new TaskProvenanceError(
      'TASK_BINDING_CHANGED',
      'The selected tooling binding differs from the task binding.',
    );
  }
  for (const input of value.retainedInputs) {
    if (!within(inputsRoot, fs.realpathSync(input.path)))
      throw new TaskProvenanceError(
        'TASK_PROVENANCE_INVALID',
        'A retained task input escapes its task directory.',
      );
    if (taskInputDigest(input.path) !== input.sha256) {
      throw new TaskProvenanceError(
        'TASK_INPUT_CHANGED',
        `Retained task input changed: ${input.path}`,
      );
    }
  }
  const manifest: unknown = JSON.parse(
    fs.readFileSync(path.join(value.source.packageRoot, 'package.json'), 'utf8'),
  );
  if (
    !isRecord(manifest) ||
    manifest.name !== value.package.name ||
    manifest.version !== value.package.version ||
    sha256(value.resolvedExecutable) !== value.entrySha256 ||
    taskInputDigest(value.source.packageRoot) !== value.packageTreeSha256
  ) {
    throw new TaskProvenanceError(
      'TASK_EXECUTABLE_CHANGED',
      'The retained task executable or its package changed.',
    );
  }
  return value;
}

/** Called by the task producer after selection and before it emits a marker. */
export function retainTaskExecution(
  taskDir: string,
  input: TaskExecutionInput,
): TaskExecutionProvenance {
  if (fs.existsSync(path.join(taskDir, receiptFile))) {
    return verifyTaskExecutionProvenance(taskDir, input.bindingIdentity);
  }
  const distribution = fs.realpathSync(input.distributionRoot);
  const packageRoot = fs.realpathSync(input.packageRoot);
  const executable = fs.realpathSync(input.executable);
  for (const selected of [packageRoot, executable]) {
    const relative = path.relative(distribution, selected);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new TaskProvenanceError(
        'TASK_INSTALL_UNSUPPORTED',
        'The CLI must belong to its selected installed distribution.',
      );
    }
  }
  const retainedInputs = [
    ...new Set([distribution, ...input.inputs.map((source) => fs.realpathSync(source))]),
  ].map((source, index) =>
    retainTaskInput(source, path.join(taskDir, 'inputs', 'tooling', String(index)), [
      path.resolve(taskDir),
    ]),
  );
  if (input.selectedConfiguration !== undefined) {
    const selection = path.resolve(taskDir, 'inputs', 'recipe-binding.json');
    fs.writeFileSync(selection, input.selectedConfiguration, { flag: 'wx' });
    retainedInputs.push({ source: selection, path: selection, sha256: taskInputDigest(selection) });
  }
  const retainedDistribution = retainedInputs[0]!;
  const retainedPackage = path.join(
    retainedDistribution.path,
    path.relative(distribution, packageRoot),
  );
  const retainedExecutable = path.join(
    retainedDistribution.path,
    path.relative(distribution, executable),
  );
  const manifest: unknown = JSON.parse(
    fs.readFileSync(path.join(retainedPackage, 'package.json'), 'utf8'),
  );
  if (
    !isRecord(manifest) ||
    manifest.name !== '@farmslot/cli' ||
    typeof manifest.version !== 'string'
  ) {
    throw new TaskProvenanceError(
      'TASK_INSTALL_UNSUPPORTED',
      'The selected CLI has no package identity.',
    );
  }
  const receipt: TaskExecutionProvenance = {
    schemaVersion: 1,
    package: { name: manifest.name, version: manifest.version },
    source: { kind: 'task-retained', packageRoot: retainedPackage },
    resolvedExecutable: retainedExecutable,
    entrySha256: sha256(retainedExecutable),
    packageTreeSha256: taskInputDigest(retainedPackage),
    recordedAt: new Date().toISOString(),
    bindingIdentity: input.bindingIdentity,
    retainedInputs,
  };
  fs.mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, receiptFile), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return receipt;
}
