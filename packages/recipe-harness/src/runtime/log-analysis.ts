import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readDecisionState, writeDecisionState } from './deps-readiness.js';

export function packageRootsForModule(target: string, moduleName: string): string[] {
  if (moduleName.startsWith('@')) {
    const parts = moduleName.split('/');
    if (parts.length >= 2) return [path.join(target, 'node_modules', parts[0], parts[1])];
    return [path.join(target, 'node_modules', parts[0])];
  }
  return [path.join(target, 'node_modules', moduleName.split('/')[0])];
}

/** True when the resolved package root contains package.json (ignores empty dirs). */
export function moduleExistsInNodeModules(target: string, moduleName: string): boolean {
  for (const pkgRoot of packageRootsForModule(target, moduleName)) {
    if (!fs.existsSync(pkgRoot)) continue;
    if (fs.existsSync(path.join(pkgRoot, 'package.json'))) return true;
  }
  return false;
}

export function unresolvedModulesFromLogSlice(lines: string[], startIndex = 0): string[] {
  const found = new Set<string>();
  for (let i = Math.max(0, startIndex); i < lines.length; i += 1) {
    const match = /Unable to resolve "([^"]+)"/u.exec(lines[i]);
    if (match) found.add(match[1]);
  }
  return [...found];
}

export function bundleErrorExcerptHash(excerpt: string): string {
  return crypto.createHash('sha256').update(excerpt).digest('hex').slice(0, 16);
}

export interface LogBoundaryScan {
  lastErr: number;
  lastOk: number;
}

export function scanLogBoundaries(
  lines: string[],
  options: { errorPattern: RegExp; okPattern: RegExp },
): LogBoundaryScan {
  let lastErr = -1;
  let lastOk = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (options.errorPattern.test(lines[i])) lastErr = i;
    if (options.okPattern.test(lines[i])) lastOk = i;
  }
  return { lastErr, lastOk };
}

/**
 * Return the last capture group from `errorPattern` when the error is not
 * superseded by a later `okPattern` line (e.g. stale native-module errors).
 */
export function supersededErrorCapture(
  logText: string,
  options: { errorPattern: RegExp; okPattern: RegExp },
): string | null {
  const lines = logText.split('\n');
  const { lastErr, lastOk } = scanLogBoundaries(lines, options);
  if (lastOk >= 0 && lastOk > lastErr) return null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = options.errorPattern.exec(lines[i]);
    if (match?.[1]) return match[1];
  }
  return null;
}

export interface BundleLogAnalysis {
  status: 'ok' | 'errors' | 'bundling' | 'no-log';
  reason?: 'bundle-error' | 'unresolved-module' | 'stale-bundle-error';
  excerpt?: string;
  unresolvedModules?: string[];
}

export interface AnalyzeBundleLogOptions {
  target: string;
  logText: string;
  errorPattern: RegExp;
  okPattern: RegExp;
  bundlingPattern?: RegExp;
}

export function analyzeBundleLog(options: AnalyzeBundleLogOptions): BundleLogAnalysis {
  const lines = options.logText.split('\n');
  const { lastErr, lastOk } = scanLogBoundaries(lines, {
    errorPattern: options.errorPattern,
    okPattern: options.okPattern,
  });
  const sliceStart = lastOk >= 0 ? lastOk + 1 : 0;
  const unresolved = unresolvedModulesFromLogSlice(lines, sliceStart).filter(
    (name) => !moduleExistsInNodeModules(options.target, name),
  );
  if (unresolved.length > 0 && lastErr > lastOk) {
    return {
      status: 'errors',
      reason: 'unresolved-module',
      excerpt: `Missing node_modules entries: ${unresolved.slice(0, 3).join(', ')}`,
      unresolvedModules: unresolved,
    };
  }
  if (lastErr > lastOk) {
    const excerpt = lines
      .slice(lastErr, lastErr + 3)
      .join(' | ')
      .slice(0, 400);
    const cited = unresolvedModulesFromLogSlice(lines, sliceStart);
    const stillMissing = cited.filter((name) => !moduleExistsInNodeModules(options.target, name));
    if (cited.length > 0 && stillMissing.length === 0) {
      return { status: 'errors', reason: 'stale-bundle-error', excerpt, unresolvedModules: cited };
    }
    return { status: 'errors', reason: 'bundle-error', excerpt };
  }
  if (lastOk >= 0) return { status: 'ok' };
  const bundlingPattern = options.bundlingPattern ?? /Bundling|index\.(js|tsx?).*%/u;
  const bundling = lines.some((line) => bundlingPattern.test(line));
  return bundling ? { status: 'bundling' } : { status: 'no-log' };
}

export interface PersistentBundleErrorDecision {
  blocked: boolean;
  excerptHash: string;
}

/** Block when the same bundle-error excerpt was already recorded for this target. */
export function evaluatePersistentBundleError(
  target: string,
  excerpt: string,
  stateFile = 'bundle-error-state.json',
): PersistentBundleErrorDecision {
  const excerptHash = bundleErrorExcerptHash(excerpt);
  const prev = readDecisionState(target, stateFile);
  if (prev?.excerptHash === excerptHash) {
    return { blocked: true, excerptHash };
  }
  writeDecisionState(target, stateFile, { excerptHash, recordedAt: Date.now() });
  return { blocked: false, excerptHash };
}
