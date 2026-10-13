import { isRecord } from '../recipe/common.js';

import type { SourceConfiguration, SourceEntryRef } from './contracts.js';

export function assertSourceEntry(value: unknown): asserts value is SourceEntryRef {
  if (
    !isRecord(value) ||
    typeof value.sourceId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(String(value.sourceId)) ||
    typeof value.entry !== 'string' ||
    !isContainedSourceEntry(value.entry) ||
    Object.keys(value).some((key) => !['sourceId', 'entry'].includes(key))
  )
    throw new Error('Source binding requires a sourceId and contained relative entry');
}

export function isContainedSourceEntry(value: string): boolean {
  return (
    value === '.' ||
    (/^[a-zA-Z0-9_.@/-]+$/.test(value) &&
      !value.startsWith('/') &&
      !value.split('/').some((part) => !part || part === '.' || part === '..'))
  );
}

/** Credential-free Git repository identity; authentication remains Git's responsibility. */
export function canonicalSourceRepo(value: string): string {
  const scp = /^git@([^/:]+):([^\s]+)$/.exec(value);
  const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value);
  if (
    !['https:', 'ssh:'].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) ||
    !url.hostname ||
    !/^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\/?$/.test(url.pathname)
  )
    throw new Error('Source repository must be a credential-free HTTPS or Git SSH identity');
  url.pathname = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  return url.toString().replace(/\/$/, '');
}

export function assertSourceConfiguration(value: unknown): asserts value is SourceConfiguration {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !Number.isSafeInteger(value.pollIntervalMs) ||
    Number(value.pollIntervalMs) < 1_000 ||
    Number(value.pollIntervalMs) > 300_000 ||
    !Array.isArray(value.sources) ||
    !isRecord(value.packs) ||
    Object.keys(value).some(
      (key) => !['schemaVersion', 'revision', 'pollIntervalMs', 'sources', 'packs'].includes(key),
    )
  )
    throw new Error('Invalid source configuration or unsupported schema');
  const ids = new Set<string>();
  for (const source of value.sources) {
    if (
      !isRecord(source) ||
      typeof source.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(source.id) ||
      ids.has(source.id) ||
      !['pack', 'recipe-library', 'helper'].includes(String(source.kind)) ||
      typeof source.repo !== 'string' ||
      (source.ref !== undefined &&
        (typeof source.ref !== 'string' || !source.ref || source.ref.startsWith('-'))) ||
      Object.keys(source).some((key) => !['id', 'kind', 'repo', 'ref'].includes(key))
    )
      throw new Error('Invalid or duplicate source declaration');
    canonicalSourceRepo(source.repo);
    ids.add(source.id);
  }
  for (const [project, binding] of Object.entries(value.packs)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(project)) throw new Error('Invalid pack name');
    assertSourceEntry(binding);
    if (!value.sources.some((source) => source.id === binding.sourceId && source.kind === 'pack'))
      throw new Error(`Pack ${project} references an undeclared pack source`);
  }
}

/** Canonical ordering is shared by locks, integrity receipts and mutation comparisons. */
export function canonicalSourceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSourceJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSourceJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
