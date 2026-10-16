import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
  pin: string;
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
  /** Selected provider workspaces whose manifest-declared installed dependencies are retained. */
  dependencyRoots?: readonly string[];
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
const pinPaths = new WeakMap<TaskExecutionInput, Map<string, string>>();
function taskPinRoot(): string {
  return path.resolve(
    process.env.FARMSLOT_HOME || path.join(os.homedir(), '.farmslot'),
    'task-pins',
  );
}
/** Producer-owned pin identity, allocated before rendering but written only after validation. */
export function taskExecutionPin(taskDir: string, input: TaskExecutionInput): string {
  let paths = pinPaths.get(input);
  if (!paths) {
    paths = new Map();
    pinPaths.set(input, paths);
  }
  const key = path.resolve(taskDir);
  let pin = paths.get(key);
  if (!pin) {
    pin = path.join(taskPinRoot(), randomUUID().replaceAll('-', ''));
    paths.set(key, pin);
  }
  return pin;
}

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
    typeof value.pin === 'string' &&
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
  const taskRoot = fs.realpathSync(taskDir);
  const storeRoot = fs.realpathSync(taskPinRoot());
  if (storeRoot === taskRoot || storeRoot.startsWith(`${taskRoot}${path.sep}`))
    throw new TaskProvenanceError(
      'TASK_PROVENANCE_INVALID',
      'The installation pin store must be outside the task.',
    );
  const pin = fs.realpathSync(value.pin);
  if (path.dirname(pin) !== fs.realpathSync(taskPinRoot()))
    throw new TaskProvenanceError(
      'TASK_PROVENANCE_INVALID',
      'The task pin is outside the configured installation store.',
    );
  const authority: unknown = JSON.parse(fs.readFileSync(path.join(pin, 'provenance.json'), 'utf8'));
  if (
    isRecord(authority) &&
    typeof authority.taskDir === 'string' &&
    authority.taskDir !== fs.realpathSync(taskDir)
  )
    throw new TaskProvenanceError(
      'TASK_PROVENANCE_RELOCATED',
      'This receipt belongs to another task directory. Keep the original task and pin; author a fresh task for a new allocation. Never remove the receipt or copy foreign pinned commands.',
    );

  if (
    !isRecord(authority) ||
    typeof authority.taskDir !== 'string' ||
    !isDeepStrictEqual(authority.receipt, value)
  ) {
    throw new TaskProvenanceError(
      'TASK_PROVENANCE_INVALID',
      'The task receipt differs from its producer-owned installation pin.',
    );
  }
  const inputsRoot = fs.realpathSync(path.join(taskDir, 'inputs'));
  const within = (root: string, file: string): boolean =>
    file === root || file.startsWith(`${root}${path.sep}`);
  const distribution = fs.realpathSync(value.retainedInputs[0]!.path);
  if (
    value.package.name !== '@farmslot/cli' ||
    value.source.kind !== 'task-retained' ||
    distribution !== fs.realpathSync(path.join(pin, 'cli')) ||
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
    if (
      !within(inputsRoot, fs.realpathSync(input.path)) &&
      !within(pin, fs.realpathSync(input.path))
    )
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
  additionalInputs: readonly string[] = [],
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
  const pin = taskExecutionPin(taskDir, input);
  const store = taskPinRoot();
  if (store === path.resolve(taskDir) || store.startsWith(`${path.resolve(taskDir)}${path.sep}`))
    throw new TaskProvenanceError(
      'TASK_PROVENANCE_INVALID',
      'The installation pin store must be outside the task.',
    );
  fs.mkdirSync(store, { recursive: true });
  const staging = fs.mkdtempSync(path.join(store, '.staging-'));
  try {
    const cli = retainTaskInput(distribution, path.join(staging, 'cli'), [
      path.resolve(taskDir),
      store,
    ]);
    const retainedInputs: TaskRetainedInput[] = [{ ...cli, path: path.join(pin, 'cli') }];
    for (const source of [
      ...new Set([...input.inputs, ...additionalInputs].map((file) => fs.realpathSync(file))),
    ]) {
      const covering = retainedInputs.find(
        (entry) => source === entry.source || source.startsWith(`${entry.source}${path.sep}`),
      );
      if (covering) {
        const retained = path.join(
          staging,
          path.relative(pin, covering.path),
          path.relative(covering.source, source),
        );
        if (!fs.existsSync(retained))
          throw new Error(`Selected task input was excluded from its tooling workspace: ${source}`);
        continue;
      }
      const relative = path.join('inputs', String(retainedInputs.length), path.basename(source));
      const dependencies: TaskRetainedInput[] = [];
      const copied = retainTaskInput(
        source,
        path.join(staging, relative),
        [path.resolve(taskDir), store],
        {
          dependencies: input.dependencyRoots?.some((root) => fs.realpathSync(root) === source),
          onDependency: (entry) => dependencies.push(entry),
        },
      );
      for (const entry of dependencies)
        retainedInputs.push({ ...entry, path: path.join(pin, path.relative(staging, entry.path)) });
      retainedInputs.push({ ...copied, path: path.join(pin, relative) });
    }
    fs.mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
    if (input.selectedConfiguration !== undefined) {
      const selection = path.resolve(taskDir, 'inputs/recipe-binding.json');
      fs.writeFileSync(selection, input.selectedConfiguration, { flag: 'wx' });
      retainedInputs.push({
        source: selection,
        path: selection,
        sha256: taskInputDigest(selection),
      });
    }
    const retainedPackage = path.join(pin, 'cli', path.relative(distribution, packageRoot));
    const retainedExecutable = path.join(pin, 'cli', path.relative(distribution, executable));
    const copiedPackage = path.join(staging, 'cli', path.relative(distribution, packageRoot));
    const copiedExecutable = path.join(staging, 'cli', path.relative(distribution, executable));
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(copiedPackage, 'package.json'), 'utf8'),
    );
    if (
      !isRecord(manifest) ||
      manifest.name !== '@farmslot/cli' ||
      typeof manifest.version !== 'string'
    )
      throw new TaskProvenanceError(
        'TASK_INSTALL_UNSUPPORTED',
        'The selected CLI has no package identity.',
      );
    const receipt: TaskExecutionProvenance = {
      schemaVersion: 1,
      pin,
      package: { name: manifest.name, version: manifest.version },
      source: { kind: 'task-retained', packageRoot: retainedPackage },
      resolvedExecutable: retainedExecutable,
      entrySha256: sha256(copiedExecutable),
      packageTreeSha256: taskInputDigest(copiedPackage),
      recordedAt: new Date().toISOString(),
      bindingIdentity: input.bindingIdentity,
      retainedInputs,
    };
    fs.writeFileSync(
      path.join(staging, 'provenance.json'),
      JSON.stringify({ taskDir: fs.realpathSync(taskDir), receipt }) + '\n',
      { mode: 0o444, flag: 'wx' },
    );
    fs.renameSync(staging, pin);
    fs.mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, receiptFile), JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
    });
    return receipt;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
