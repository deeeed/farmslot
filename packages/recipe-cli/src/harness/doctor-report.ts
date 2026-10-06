// The doctor report every host prints: the shared checks and the required-check
// tally, the harness's own provenance, and the platform's checks. The host adds
// its report fields (what the checkout looks like to it).

import fs from 'node:fs';
import path from 'node:path';

import type { AdapterDoctorCheck } from '@farmslot/adapter-sdk';

import { RECIPE_CLI_VERSION } from '../version.js';

import { harnessAdapter } from './adapters.js';
import { harnessHost, hostEnvName } from './host.js';
import { harnessExecutable } from './paths.js';
import { adapterReadiness } from './readiness.js';

export type DoctorCheck = AdapterDoctorCheck;

export interface RequiredDoctorChecks {
  status: 'pass' | 'fail';
  total: number;
  passed: number;
  failed: string[];
}

export type RunnerInstallKind =
  | 'local-link'
  | 'source-checkout'
  | 'project-install'
  | 'global-install'
  | 'pinned-install';

export interface RunnerProvenance {
  name: string;
  packageName: string;
  version: string;
  runnerDir: string;
  packagePath: string;
  packageSource: 'source-checkout' | 'node_modules' | 'pin';
  installKind: RunnerInstallKind;
  linked: boolean;
  global: boolean;
  invokedPath: string;
  executablePath: string;
  actionManifestPath: string;
  harnessPackage: '@farmslot/recipe-runner';
  /** The @farmslot/recipe-cli version the harness runs on. */
  recipeCliVersion: string;
}

export interface RunnerProvenanceOptions {
  // The runner name the report carries (default: the host package name).
  name?: string;
  // Whether the host package root is a pinned copy.
  pinned?(root: string): boolean;
}

export interface DoctorReport {
  schemaVersion: 1;
  protocolVersion: 'v1';
  runner_protocol_version: 1;
  status: 'pass' | 'fail';
  checks: DoctorCheck[];
  requiredChecks: RequiredDoctorChecks;
  adapter: string;
  target: string;
  runner: RunnerProvenance;
  manifestValidation: unknown;
  [field: string]: unknown;
}

export interface DoctorReportOptions {
  // Checks the host reports right after `manifest` (its bridge, say).
  checks?(target: string, adapter: string): DoctorCheck[];
  // The host's report fields between `runner` and `manifestValidation`, in
  // order. `environment` is the platform's; place it where the host wants it.
  fields?(
    target: string,
    adapter: string,
    environment: Record<string, unknown>,
  ): Record<string, unknown>;
  provenance?: RunnerProvenanceOptions;
}

export function requiredDoctorCheckSummary(checks: readonly DoctorCheck[]): RequiredDoctorChecks {
  const required = checks.filter((check) => check.required);
  const failed = required.filter((check) => check.status === 'fail').map((check) => check.id);
  return {
    status: failed.length === 0 ? 'pass' : 'fail',
    total: required.length,
    passed: required.length - failed.length,
    failed,
  };
}

export function createDoctorReport(
  adapter: string,
  target: string,
  manifestValidation: { summary?: { errors?: number } & Record<string, unknown> },
  actionManifestPath: string = harnessAdapter(adapter).actions.manifestPath(),
  platform?: string,
  options: DoctorReportOptions = {},
): DoctorReport {
  const readiness = adapterReadiness(harnessAdapter(adapter));
  const manifestErrors = Number(manifestValidation.summary?.errors ?? 0);
  const checks: DoctorCheck[] = [
    {
      id: 'manifest',
      status: manifestErrors === 0 ? 'pass' : 'fail',
      required: true,
      message:
        manifestErrors === 0
          ? 'Action manifest is valid Recipe v1.'
          : `Action manifest has ${manifestErrors} validation error(s).`,
    },
    ...(options.checks?.(target, adapter) ?? []),
    ...(readiness.checks?.(target, platform) ?? []),
  ];
  const requiredChecks = requiredDoctorCheckSummary(checks);
  const environment = readiness.environment?.(target) ?? {};
  return {
    schemaVersion: 1,
    protocolVersion: 'v1',
    runner_protocol_version: 1,
    status: requiredChecks.status,
    checks,
    requiredChecks,
    adapter,
    target,
    runner: runnerProvenance(actionManifestPath, options.provenance),
    ...(options.fields?.(target, adapter, environment) ?? { environment }),
    manifestValidation: manifestValidation.summary,
  };
}

export function runnerInstallKind(
  runnerRoot: string,
  invokedPath: string,
  executablePath: string,
  pinned: (root: string) => boolean = () => false,
): RunnerInstallKind {
  if (pinned(runnerRoot)) return 'pinned-install';
  const normalizedRoot = path.normalize(runnerRoot);
  const nodeModulesSegment = `${path.sep}node_modules${path.sep}`;
  const globalNodeModulesSegment = `${path.sep}lib${path.sep}node_modules${path.sep}`;
  if (normalizedRoot.includes(globalNodeModulesSegment)) return 'global-install';
  const nodeModulesIndex = normalizedRoot.lastIndexOf(nodeModulesSegment);
  if (nodeModulesIndex >= 0) {
    const nodeModulesRoot = normalizedRoot.slice(
      0,
      nodeModulesIndex + nodeModulesSegment.length - 1,
    );
    const invoked = path.resolve(invokedPath);
    const projectBin = `${path.join(nodeModulesRoot, '.bin')}${path.sep}`;
    if (invoked === path.resolve(executablePath) || invoked.startsWith(projectBin)) {
      return 'project-install';
    }
    return 'global-install';
  }
  if (path.resolve(invokedPath) !== path.resolve(executablePath)) return 'local-link';
  return 'source-checkout';
}

/** Which harness is running, from where, and how it was installed. */
export function runnerProvenance(
  actionManifestPath: string,
  options: RunnerProvenanceOptions = {},
): RunnerProvenance {
  const host = harnessHost();
  const runnerDir = host.packageRoot;
  const packagePath = path.join(runnerDir, 'package.json');
  const packageDocument = readJsonObject(packagePath);
  const packageName = packageDocument.name;
  const version = packageDocument.version;
  if (packageName !== host.packageName) {
    throw new Error(`Expected ${host.packageName} package name in ${packagePath}`);
  }
  if (typeof version !== 'string' || !version) {
    throw new Error(`Expected package version in ${packagePath}`);
  }
  const pinned = options.pinned ?? (() => false);
  const executablePath = harnessExecutable();
  const invokedPath = path.resolve(process.env[hostEnvName('INVOKED_AS')] ?? executablePath);
  const installKind = runnerInstallKind(runnerDir, invokedPath, executablePath, pinned);
  const packageSource = pinned(runnerDir)
    ? 'pin'
    : runnerDir.includes(`${path.sep}node_modules${path.sep}`)
      ? 'node_modules'
      : 'source-checkout';
  return {
    name: options.name ?? host.packageName,
    packageName,
    version,
    runnerDir,
    packagePath,
    packageSource,
    installKind,
    linked: installKind === 'local-link',
    global: installKind === 'global-install',
    invokedPath,
    executablePath,
    actionManifestPath,
    harnessPackage: '@farmslot/recipe-runner',
    recipeCliVersion: RECIPE_CLI_VERSION,
  };
}

function readJsonObject(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected JSON object in ${file}`);
  }
  return value as Record<string, unknown>;
}
