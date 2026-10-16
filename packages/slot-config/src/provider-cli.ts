import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ProviderCliHealth } from '@farmslot/protocol';

const execute = promisify(execFile);
const MARKER = 'FARMSLOT_PROVIDER_PATH';
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export type ProviderCliRunner = (
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
) => Promise<string>;

const run: ProviderCliRunner = async (executable, args, env, timeoutMs = 5_000) =>
  (await execute(executable, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 })).stdout;

function probeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Probe the invoked executable, without a caller's provider override delegating elsewhere.
  for (const name of Object.keys(env)) {
    if (name.endsWith('_BIN') || name.endsWith('_PACKAGE_ROOT')) delete env[name];
  }
  return env;
}

export async function poolProviderRoots(poolFile: string): Promise<string[]> {
  const pool = JSON.parse(await readFile(poolFile, 'utf8'));
  return [
    ...new Set<string>(
      Object.entries(pool.env ?? {})
        .filter(([name, value]) => name.endsWith('_PACKAGE_ROOT') && typeof value === 'string')
        .map(([, value]) => String(value)),
    ),
  ];
}

async function providerMetadata(root: string) {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (
    typeof metadata.name !== 'string' ||
    !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(metadata.name) ||
    typeof metadata.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)
  ) {
    throw new Error('Pinned provider must declare an exact package name and version');
  }
  const bins: Record<string, string> =
    typeof metadata.bin === 'string'
      ? { [metadata.name.split('/').at(-1)]: metadata.bin }
      : metadata.bin;
  if (
    !bins ||
    Object.keys(bins).length === 0 ||
    Object.entries(bins).some(
      ([name, file]) =>
        !/^[a-zA-Z0-9._-]+$/.test(name) ||
        typeof file !== 'string' ||
        path.relative(root, path.resolve(root, file)).startsWith('..'),
    )
  ) {
    throw new Error('Pinned provider must declare checkout-contained public binaries');
  }
  return { name: metadata.name as string, version: metadata.version as string, bins };
}

export async function inspectProviderCli(
  root: string,
  runner: ProviderCliRunner = run,
): Promise<ProviderCliHealth> {
  const health: ProviderCliHealth = {
    root,
    packageName: 'unknown',
    expectedVersion: 'unknown',
    ok: false,
    checkedAt: new Date().toISOString(),
    binaries: [],
  };
  try {
    const metadata = await providerMetadata(root);
    health.packageName = metadata.name;
    health.expectedVersion = metadata.version;
    const env = probeEnvironment();
    const shell = process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const shellPaths: Array<{ scope: string; path: string }> = [
      { scope: 'node', path: env.PATH ?? '' },
    ];
    for (const mode of ['non-interactive', 'login', 'interactive']) {
      const flag = mode === 'non-interactive' ? '-c' : mode === 'login' ? '-lc' : '-lic';
      const output = await runner(shell, [flag, `printf '\\0${MARKER}\\0%s\\0' "$PATH"`], {
        ...env,
        PATH: SYSTEM_PATH,
      });
      const fields = output.split('\0');
      const marker = fields.lastIndexOf(MARKER);
      if (marker < 0 || !fields[marker + 1])
        throw new Error(`${mode} shell did not report its PATH`);
      shellPaths.push({ scope: mode, path: fields[marker + 1] });
    }
    const versions = new Map<string, Promise<string>>();
    const version = async (file: string, searchPath = env.PATH) => {
      const resolved = await realpath(file);
      const key = `${resolved}\0${searchPath}`;
      let result = versions.get(key);
      if (!result) {
        result = runner(file, ['--version'], { ...env, PATH: searchPath }).then((stdout) =>
          stdout.trim(),
        );
        versions.set(key, result);
      }
      return result;
    };
    for (const [name, relative] of Object.entries(metadata.bins)) {
      if ((await version(path.join(root, relative))) !== metadata.version)
        throw new Error(`${name}: pinned binary does not match its package version`);
      for (const item of shellPaths) {
        let found = false;
        const candidates = [
          ...new Set(item.path.split(path.delimiter).map((dir) => path.resolve(dir || '.', name))),
        ];
        for (const candidate of candidates) {
          try {
            await access(candidate, constants.X_OK);
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              ['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error.code))
            )
              continue;
            throw error;
          }
          found = true;
          const actual = await version(candidate, item.path);
          health.binaries.push({ name, path: candidate, scope: item.scope, version: actual });
        }
        if (!found) throw new Error(`${name}: missing from ${item.scope} PATH`);
      }
    }
    const mismatches = health.binaries.filter((binary) => binary.version !== metadata.version);
    health.ok = mismatches.length === 0;
    if (!health.ok)
      health.reason = mismatches
        .map(
          (binary) =>
            `${binary.scope} ${binary.name}: ${binary.version}, expected ${metadata.version}`,
        )
        .join('; ');
  } catch (error) {
    health.reason = error instanceof Error ? error.message : String(error);
  }
  return health;
}

export async function installProviderCli(
  root: string,
  prefix?: string,
  runner: ProviderCliRunner = run,
): Promise<ProviderCliHealth> {
  const metadata = await providerMetadata(root);
  await runner(
    'npm',
    [
      'install',
      '--global',
      ...(prefix ? ['--prefix', prefix] : []),
      `${metadata.name}@${metadata.version}`,
    ],
    process.env,
    120_000,
  );
  const health = await inspectProviderCli(root, runner);
  if (!health.ok) throw new Error(`Provider rollout failed: ${health.reason}`);
  return health;
}
