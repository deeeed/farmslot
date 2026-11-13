// One-shot scrub of credential values already stored in run records. Reports
// names, record ids and field paths only; never a value. No backup copies.
import { realpathSync } from 'node:fs';
import { chmod, lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type FarmPathEnv, resolveReportedFarmPaths } from '@farmslot/protocol/node/farm-paths';

import {
  isCredentialName,
  isSecretValue,
  redactCommandCredentials,
  REDACTED_CREDENTIAL,
} from '../core/credential-redaction.js';

export interface ScrubFinding {
  file: string;
  /** JSON paths of fields whose credential values were (or would be) replaced. */
  fields: string[];
  values: number;
}

export interface ScrubReport {
  scanned: number;
  findings: ScrubFinding[];
  /** Archive bundles hold copies this scrub cannot rewrite in place. */
  bundles: string[];
}

function scrubValue(
  value: unknown,
  at: string,
  fields: Map<string, number>,
): { value: unknown; count: number } {
  if (typeof value === 'string') {
    const { text, count } = redactCommandCredentials(value);
    if (count) fields.set(at, (fields.get(at) ?? 0) + count);
    return { value: text, count };
  }
  if (!value || typeof value !== 'object') return { value, count: 0 };
  let count = 0;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    const childAt = Array.isArray(value) ? `${at}[${key}]` : `${at}.${key}`;
    let next: unknown;
    if (
      typeof key === 'string' &&
      isCredentialName(key) &&
      typeof child === 'string' &&
      isSecretValue(child, key)
    ) {
      // An environment map: { LITELLM_API_KEY: '…' }.
      next = REDACTED_CREDENTIAL;
      fields.set(childAt, (fields.get(childAt) ?? 0) + 1);
      count += 1;
    } else {
      const scrubbed = scrubValue(child, childAt, fields);
      next = scrubbed.value;
      count += scrubbed.count;
    }
    (value as Record<string | number, unknown>)[key] = next;
  }
  return { value, count };
}

/** Returns the scrubbed text and its findings, or null when the text is not JSON. */
export function scrubRecordText(
  raw: string,
  jsonLines: boolean,
): { text: string; fields: string[]; values: number } | null {
  const fields = new Map<string, number>();
  let values = 0;
  const scrubDocument = (source: string, at: string): string => {
    const document: unknown = JSON.parse(source);
    const scrubbed = scrubValue(document, at, fields);
    values += scrubbed.count;
    if (!scrubbed.count) return source;
    const indent = /^[[{]\r?\n( +)/u.exec(source)?.[1]?.length ?? 0;
    return JSON.stringify(scrubbed.value, null, indent) + (/\n$/u.test(source) ? '\n' : '');
  };
  try {
    const text = jsonLines
      ? raw
          .split('\n')
          .map((line, index) => (line.trim() ? scrubDocument(line, `[line ${index + 1}]`) : line))
          .join('\n')
      : scrubDocument(raw, '$');
    return { text, fields: [...fields.keys()], values };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function replaceFile(file: string, text: string, mode: number): Promise<void> {
  const temporary = `${file}.scrub-${process.pid}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, mode & 0o777);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The gateway's run stores, resolved like `farmslot paths`: the runs directory (live runs,
 * archive/, quarantine/, journals), the run archive, the configured run bundle store, and the
 * run-archive/ and archive/ beside those stores in their data directory. The farm home itself
 * holds live credentials and is never a root.
 */
export function defaultScrubRoots(env: FarmPathEnv = process.env): string[] {
  const paths = resolveReportedFarmPaths({ role: 'gateway', env });
  const { runArchive, runBundles } = paths.data;
  const dataDirs = [path.dirname(runBundles), path.dirname(runArchive)].filter(
    (dir) => path.resolve(dir) !== path.resolve(paths.home),
  );
  return [
    ...new Set([
      paths.state.runs,
      runArchive,
      runBundles,
      ...dataDirs.flatMap((dir) => [path.join(dir, 'run-archive'), path.join(dir, 'archive')]),
    ]),
  ];
}

/** The real path, following symlinks; a missing tail is joined to its nearest real ancestor. */
function realPath(target: string): string {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(realPath(parent), path.basename(resolved));
  }
}

/** System trees no run store lives in. */
const SYSTEM_DIRS = [
  '/System',
  '/Applications',
  '/Library',
  '/usr',
  '/bin',
  '/sbin',
  '/opt/homebrew',
];

/**
 * Why an explicit root must not be scanned, or '' when it may be: the filesystem root, the home
 * directory, the farm home (it holds live credentials) or a directory containing it, a system
 * tree, or a shallow path such as /Users/x or /Volumes/disk (fewer than 3 segments, unless inside
 * the temp dir). Compared by real path.
 */
export function unsafeScrubRoot(root: string, env: FarmPathEnv = process.env): string {
  const real = realPath(root);
  const farmHome = realPath(resolveReportedFarmPaths({ role: 'gateway', env }).home);
  const shown = real === path.resolve(root) ? '' : ` (resolves to ${real})`;
  if (real === path.parse(real).root) return `filesystem root${shown}`;
  if (real === realPath(os.homedir())) return `home directory${shown}`;
  if (real === farmHome) return `farm home${shown}`;
  if (farmHome.startsWith(`${real}${path.sep}`))
    return `contains the farm home ${farmHome}${shown}`;
  if (SYSTEM_DIRS.some((dir) => real === dir || real.startsWith(`${dir}/`)))
    return `system directory${shown}`;
  const insideTemp = real.startsWith(`${realPath(os.tmpdir())}${path.sep}`);
  if (!insideTemp && real.split(path.sep).filter(Boolean).length < 3)
    return `shallow path (fewer than 3 segments)${shown}`;
  return '';
}

/** When set, the scrub refuses any root or write whose real path is outside this directory. */
export const SCRUB_ALLOWED_PREFIX_ENV = 'FARMSLOT_SCRUB_ALLOWED_PREFIX';

/** Why a path falls outside FARMSLOT_SCRUB_ALLOWED_PREFIX, or '' when it is inside or unset. */
export function outsideScrubPrefix(target: string, env: FarmPathEnv = process.env): string {
  const prefix = env[SCRUB_ALLOWED_PREFIX_ENV];
  if (!prefix) return '';
  const allowed = realPath(prefix);
  const real = realPath(target);
  return real === allowed || real.startsWith(`${allowed}${path.sep}`)
    ? ''
    : `${real} is outside ${SCRUB_ALLOWED_PREFIX_ENV} ${allowed}`;
}

/** Walks each root (symlinks are not followed); rewrites only with apply. */
export async function scrubRunCredentials(
  roots: readonly string[],
  options: { apply: boolean },
): Promise<ScrubReport> {
  for (const root of roots) {
    const outside = outsideScrubPrefix(root);
    if (outside) throw new Error(`refusing scrub root ${root}: ${outside}`);
  }
  const report: ScrubReport = { scanned: 0, findings: [], bundles: [] };
  const visit = async (entry: string): Promise<void> => {
    const info = await lstat(entry).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of (await readdir(entry)).sort()) await visit(path.join(entry, name));
      return;
    }
    if (!info.isFile()) return;
    if (/\.(farmrun|tar|tgz|zst|gz)$/u.test(entry)) {
      report.bundles.push(entry);
      return;
    }
    const jsonLines = entry.endsWith('.jsonl');
    if (!jsonLines && !entry.endsWith('.json')) return;
    report.scanned += 1;
    const scrubbed = scrubRecordText(await readFile(entry, 'utf8'), jsonLines);
    if (!scrubbed?.values) return;
    report.findings.push({ file: entry, fields: scrubbed.fields, values: scrubbed.values });
    if (!options.apply) return;
    const outside = outsideScrubPrefix(entry);
    if (outside) throw new Error(`refusing scrub write ${entry}: ${outside}`);
    await replaceFile(entry, scrubbed.text, info.mode);
  };
  for (const root of roots) await visit(path.resolve(root));
  return report;
}
