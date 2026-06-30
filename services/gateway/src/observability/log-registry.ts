// log-registry.ts — Typed production/development log sources for gateway intelligence.

import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { intelligenceAuditDir } from '../auto-recovery/audit-writer.js';
import { isPathInside } from '../core/path.js';

const MAX_LOG_SOURCES = 200;
const LOG_FILE_EXTENSIONS = new Set(['.log', '.out', '.err', '.txt', '.ndjson']);
// Short TTL avoids repeated filesystem scans during one Co-Pilot tool loop;
// operators may see newly-created log files up to this many ms later.
const LOG_REGISTRY_CACHE_MS = 1_000;

type LogSourceKind = 'file' | 'directory-scan';
type LogCategory =
  | 'gateway'
  | 'monitor'
  | 'ci'
  | 'prepare'
  | 'slot-runtime'
  | 'intelligence-audit'
  | 'external';

export interface LogRegistryEntry {
  id: string;
  label: string;
  category: LogCategory;
  owner: 'gateway' | 'node' | 'slot' | 'external';
  kind: LogSourceKind;
  path: string;
  displayPath: string;
  description: string;
  exists: boolean;
  size: number | null;
  modifiedAt: string | null;
}

interface StaticLogSpec {
  id: string;
  label: string;
  category: LogCategory;
  owner: LogRegistryEntry['owner'];
  path: string;
  displayPath: string;
  description: string;
}

interface LogDirectorySpec {
  idPrefix: string;
  labelPrefix: string;
  category: LogCategory;
  owner: LogRegistryEntry['owner'];
  dir: string;
  displayPrefix: string;
  description: string;
}

function safeId(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'log'
  );
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function errorHasCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function isRecoverableLogAccessError(err: unknown): boolean {
  return (
    errorHasCode(err, 'ENOENT') || isPermissionLogAccessError(err) || errorHasCode(err, 'ELOOP')
  );
}

function isPermissionLogAccessError(err: unknown): boolean {
  return errorHasCode(err, 'EACCES') || errorHasCode(err, 'EPERM');
}

function warnSkippedLogSource(source: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[log-registry] skipping unreadable log source ${source}: ${message}`);
}

function configuredLogDir(): string {
  return process.env.FARMSLOT_LOG_DIR
    ? path.resolve(process.env.FARMSLOT_LOG_DIR)
    : path.join(farmslotHome(), 'logs');
}

function extraLogDirs(): string[] {
  return (process.env.FARMSLOT_EXTRA_LOG_DIRS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function staticLogSpecs(): StaticLogSpec[] {
  return [
    {
      id: 'gateway-dev-log',
      label: 'Gateway dev log',
      category: 'gateway',
      owner: 'gateway',
      path: '/tmp/farmslot-dev.log',
      displayPath: '<tmp>/farmslot-dev.log',
      description:
        'Development gateway log produced by the local command-center dev server wrapper.',
    },
  ];
}

function logDirectorySpecs(): LogDirectorySpec[] {
  const specs: LogDirectorySpec[] = [
    {
      idPrefix: 'production',
      labelPrefix: 'Production log',
      category: 'gateway',
      owner: 'gateway',
      dir: configuredLogDir(),
      displayPrefix: '<farmslot-logs>',
      description: 'Canonical production Farmslot log directory. Override with FARMSLOT_LOG_DIR.',
    },

    {
      idPrefix: 'intelligence-audit',
      labelPrefix: 'Intelligence audit',
      category: 'intelligence-audit',
      owner: 'gateway',
      dir: intelligenceAuditDir(),
      displayPrefix: '<intelligence-audit>',
      description:
        'Append-only NDJSON audit records for autonomous intelligence actions (ADR-031).',
    },
  ];

  for (const [index, dir] of extraLogDirs().entries()) {
    specs.push({
      idPrefix: `extra-${index + 1}`,
      labelPrefix: `Configured extra log ${index + 1}`,
      category: 'external',
      owner: 'external',
      dir,
      displayPrefix: `<extra-log-dir-${index + 1}>`,
      description: 'Additional operator-configured log directory from FARMSLOT_EXTRA_LOG_DIRS.',
    });
  }
  return specs;
}

let registryCache: { key: string; expiresAt: number; entries: LogRegistryEntry[] } | null = null;

async function staticEntry(spec: StaticLogSpec): Promise<LogRegistryEntry> {
  const missingEntry = (entryPath = path.resolve(spec.path)): LogRegistryEntry => ({
    ...spec,
    path: entryPath,
    kind: 'file',
    exists: false,
    size: null,
    modifiedAt: null,
  });
  const linkInfo = await lstat(spec.path).catch((err: unknown) => {
    if (errorHasCode(err, 'ENOENT')) return null;
    if (isRecoverableLogAccessError(err)) {
      warnSkippedLogSource(spec.path, err);
      return null;
    }
    throw err;
  });
  const canonicalPath = linkInfo
    ? await realpath(spec.path).catch((err: unknown) => {
        if (isRecoverableLogAccessError(err)) {
          warnSkippedLogSource(spec.path, err);
          return null;
        }
        throw err;
      })
    : null;
  if (!canonicalPath) return missingEntry();
  if (!linkInfo || linkInfo.isSymbolicLink()) {
    // Static registry entries are explicit files, not escape hatches to follow
    // arbitrary operator-created symlinks into broader log trees.
    return missingEntry(canonicalPath);
  }
  return {
    ...spec,
    path: canonicalPath,
    kind: 'file',
    exists: true,
    size: linkInfo.size,
    modifiedAt: linkInfo.mtime.toISOString(),
  };
}

async function scanDirectory(
  spec: LogDirectorySpec,
  maxEntries: number,
): Promise<LogRegistryEntry[]> {
  if (maxEntries <= 0) return [];
  const realDir = await realpath(spec.dir).catch((err: unknown) => {
    if (errorHasCode(err, 'ENOENT')) return null;
    if (isPermissionLogAccessError(err)) {
      warnSkippedLogSource(spec.dir, err);
      return null;
    }
    throw err;
  });
  if (!realDir) return [];
  const entries = await readdir(realDir, { withFileTypes: true }).catch((err: unknown) => {
    if (errorHasCode(err, 'ENOENT')) return [];
    if (isPermissionLogAccessError(err)) {
      warnSkippedLogSource(realDir, err);
      return [];
    }
    throw err;
  });
  const logs: LogRegistryEntry[] = [];
  for (const entry of entries) {
    if (logs.length >= maxEntries) break;
    // Dirent.isFile() is false for symlink leaves; keep scans non-following.
    if (!entry.isFile()) continue;
    if (!LOG_FILE_EXTENSIONS.has(path.extname(entry.name))) continue;

    const absPath = path.join(realDir, entry.name);
    const realFile = await realpath(absPath).catch((err: unknown) => {
      // Log rotation can remove a file between readdir and realpath; skip only
      // that expected race so permission and filesystem errors still surface.
      if (errorHasCode(err, 'ENOENT')) return null;
      throw err;
    });
    if (!realFile) continue;
    if (!isPathInside(realDir, realFile)) continue;
    const info = await lstat(realFile).catch((err: unknown) => {
      if (errorHasCode(err, 'ENOENT')) return null;
      if (isPermissionLogAccessError(err)) {
        warnSkippedLogSource(realFile, err);
        return null;
      }
      throw err;
    });
    if (!info) continue;
    const basename = path.basename(realFile);
    logs.push({
      id: `${spec.idPrefix}-${safeId(basename)}-${shortHash(realFile)}`,
      label: `${spec.labelPrefix}: ${basename}`,
      category: spec.category,
      owner: spec.owner,
      kind: 'directory-scan',
      path: realFile,
      displayPath: `${spec.displayPrefix}/${basename}`,
      description: spec.description,
      exists: true,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  return logs;
}

export async function listLogRegistryEntries(): Promise<LogRegistryEntry[]> {
  const cacheKey = [configuredLogDir(), intelligenceAuditDir(), ...extraLogDirs()].join('\0');
  const now = Date.now();
  if (registryCache?.key === cacheKey && registryCache.expiresAt > now) {
    return registryCache.entries.map((entry) => ({ ...entry }));
  }

  const entries: LogRegistryEntry[] = [];
  const seenRealPaths = new Set<string>();
  const addEntry = (entry: LogRegistryEntry) => {
    if (entries.length >= MAX_LOG_SOURCES) return;
    if (entry.exists && seenRealPaths.has(entry.path)) return;
    if (entry.exists) seenRealPaths.add(entry.path);
    entries.push(entry);
  };

  for (const entry of await Promise.all(staticLogSpecs().map(staticEntry))) {
    addEntry(entry);
  }
  for (const spec of logDirectorySpecs()) {
    if (entries.length >= MAX_LOG_SOURCES) break;
    for (const entry of await scanDirectory(spec, MAX_LOG_SOURCES - entries.length)) {
      addEntry(entry);
    }
  }

  const sortedEntries = entries
    // Missing files have no mtime and sort after existing log files.
    .sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  registryCache = {
    key: cacheKey,
    expiresAt: now + LOG_REGISTRY_CACHE_MS,
    entries: sortedEntries,
  };
  return sortedEntries.map((entry) => ({ ...entry }));
}

export async function findRegisteredLogEntry(
  rawPath: string,
  entries: readonly LogRegistryEntry[],
): Promise<LogRegistryEntry | null> {
  const requested = rawPath.trim();
  if (!requested) return null;
  const absRequested = path.isAbsolute(requested) ? path.resolve(requested) : null;
  const realRequested = absRequested
    ? await realpath(absRequested).catch((err: unknown) => {
        if (isRecoverableLogAccessError(err)) return null;
        throw err;
      })
    : null;
  const matched = entries.find(
    (entry) =>
      entry.id === requested ||
      entry.displayPath === requested ||
      entry.path === requested ||
      (absRequested && entry.path === absRequested) ||
      (realRequested && entry.path === realRequested),
  );
  return matched ?? null;
}

export function redactLogContent(content: string): string {
  return content
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(gh[pousrv]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xox[ea]-[A-Za-z0-9-]{20,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xapp-[A-Za-z0-9-]{20,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key)=([^\s]+)/gi,
      (_match, key: string, value: string) =>
        value.startsWith('[REDACTED') ? `${key}=${value}` : `${key}=[REDACTED]`,
    );
}
