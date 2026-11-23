import { createHash } from 'node:crypto';
import path from 'node:path';

import type ts from 'typescript';

import { type ArtifactRef, isRecord, type Run } from '@farmslot/protocol';

import { BASELINE_MARKER_DIR } from '../core/artifact-copy-policy.js';
import { writeAtomicJSON } from '../core/atomic-json.js';
import { loadSlotVars } from '../core/config.js';
import { execArgvOnSlot } from '../core/exec.js';

import type { PublicationManifestReadIO } from './publication-artifacts.js';

interface MarkerBaselineReceipt {
  version: 1;
  runId: string;
  ticket: string;
  baseSha: string;
  markerSha: string;
}

/** Only added diagnostic statements qualify, never a subject that labels a product edit as debug. */
export async function isTicketMarkerCommit(
  output: string,
  baseSha: string,
  markerSha: string,
  ticket: string,
): Promise<boolean> {
  const ts = await import('typescript');
  const [sha, parents, subject, patch] = output.split('\0');
  if (
    sha !== markerSha ||
    parents !== baseSha ||
    subject !== `debug(${ticket}): add reproduction marker` ||
    !patch
  )
    return false;
  let added: string[] = [];
  let files = 0;
  let markers = 0;
  /** Logger objects the worker templates prescribe for a marker, and nothing else. */
  const loggerObjects = new Set(['DevLogger', 'Logger', 'console']);
  /** Names an added import bound, checked at the end against the loggers actually logged through. */
  const importedBindings = new Set<string>();
  const loggedThrough = new Set<string>();
  /** `console.error` is admitted for the global console only, never an import bound as `console`. */
  let loggedConsoleError = false;
  const finishHunk = () => {
    if (!added.length) return true;
    const source = ts.createSourceFile('marker.ts', added.join('\n'), ts.ScriptTarget.Latest, true);
    added = [];
    const hasParseError = (node: ts.Node): boolean =>
      Boolean(node.flags & ts.NodeFlags.ThisNodeHasError) ||
      Boolean(ts.forEachChild(node, hasParseError));
    if (hasParseError(source) || !source.statements.length) return false;
    const onlyLogs = (statement: ts.Statement): boolean => {
      // A file that does not already import its logger needs the import to log
      // at all, which is why a template-conformant marker commit adds one. Only
      // a plain value import binding a name, and only when that name is what
      // the marker logs through — checked once the whole patch is read.
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        // No import clause at all is a side-effect-only import, which runs
        // module code; a phase modifier is `type` (binds nothing) or `defer`.
        if (!clause || clause.phaseModifier !== undefined) return false;
        // The module has to BE a logger module. Without this, the binding name
        // was the only rule, so `import { track as Logger } from './analytics'`
        // read as a logger import, loaded that module and aliased something
        // else behind a logger name — and a namespace import called `console`
        // shadowed the global for the rest of the file.
        if (
          !ts.isStringLiteralLike(statement.moduleSpecifier) ||
          !/(?:^|\/)(?:dev-?)?logger$/iu.test(
            statement.moduleSpecifier.text.replace(/\.[jt]sx?$/u, ''),
          )
        )
          return false;
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return false;
        const bound: string[] = [];
        // A default import binds the module's own export under the name the
        // marker logs through; a named one must not rename, so the name in the
        // log is the name the logger module exports.
        if (clause.name) bound.push(clause.name.text);
        if (clause.namedBindings)
          for (const element of clause.namedBindings.elements) {
            if (element.isTypeOnly || element.propertyName) return false;
            bound.push(element.name.text);
          }
        if (!bound.length) return false;
        for (const name of bound) importedBindings.add(name);
        return true;
      }
      if (ts.isIfStatement(statement)) {
        if (statement.elseStatement || writesValue(statement.expression)) return false;
        return ts.isBlock(statement.thenStatement)
          ? statement.thenStatement.statements.length > 0 &&
              statement.thenStatement.statements.every(onlyLogs)
          : onlyLogs(statement.thenStatement);
      }
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
        return false;
      const call = statement.expression;
      // Mobile logs through DevLogger or Logger, Terminal and Extension through
      // console; the gate used to admit only the first, so no template could
      // ever produce a marker it accepted.
      const loggerObject =
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        (call.expression.name.text === 'log' ||
          (call.expression.expression.text === 'console' && call.expression.name.text === 'error'))
          ? call.expression.expression.text
          : undefined;
      if (!loggerObject || !loggerObjects.has(loggerObject)) return false;
      const message = call.arguments[0];
      const prefix =
        message &&
        (ts.isStringLiteralLike(message)
          ? message.text
          : ts.isTemplateExpression(message)
            ? message.head.text
            : undefined);
      if (!prefix?.startsWith(`[${ticket}] BUG_MARKER:`) || call.arguments.some(writesValue))
        return false;
      loggedThrough.add(loggerObject);
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'error')
        loggedConsoleError = true;
      markers += 1;
      return true;
    };
    return source.statements.every(onlyLogs);
  };

  function writesValue(node: ts.Node): boolean {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      return true;
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      return true;
    if (
      ts.isDeleteExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    )
      return true;
    return Boolean(ts.forEachChild(node, writesValue));
  }

  /**
   * An import earns its place only by being the logger the marker logs through
   * IN THE SAME FILE. Commit-wide sets let an import in one file be justified
   * by a marker in another, so the sets close and reset at each file boundary.
   */
  const closeFile = (): boolean => {
    const justified =
      [...importedBindings].every((name) => loggedThrough.has(name)) &&
      !(loggedConsoleError && importedBindings.has('console'));
    importedBindings.clear();
    loggedThrough.clear();
    loggedConsoleError = false;
    return justified;
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (!finishHunk() || !closeFile()) return false;
      files += 1;
    } else if (line.startsWith('@@ ')) {
      if (!finishHunk()) return false;
    } else if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
      continue;
    } else if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('index ')) {
      if (!/^index [a-f0-9]+\.\.[a-f0-9]+ 100(?:644|755)$/u.test(line)) return false;
    } else if (line !== '') return false; // Deletions, renames, modes, binary data and context all refuse.
  }
  return finishHunk() && closeFile() && files > 0 && markers > 0;
}

/** Capture verifies Git once; retained readers admit only the exact gateway-owned, pinned receipt. */
export function markerBaselineVerifier(run: Run, inventory: readonly ArtifactRef[] | null) {
  const checks = new Map<string, Promise<boolean>>();
  return (
    markerSha: string,
    baseSha: string,
    io: PublicationManifestReadIO,
    artifactsDir: string,
  ): Promise<boolean> => {
    const key = `${baseSha}/${markerSha}`;
    let pending = checks.get(key);
    if (!pending) {
      pending = verify(markerSha, baseSha, io, artifactsDir);
      checks.set(key, pending);
    }
    return pending;
  };
  async function verify(
    markerSha: string,
    baseSha: string,
    io: PublicationManifestReadIO,
    artifactsDir: string,
  ): Promise<boolean> {
    if (
      run.flowType !== 'fix-bug' ||
      !run.taskFile ||
      !/^[a-f0-9]{40}$/u.test(markerSha) ||
      !/^[a-f0-9]{40}$/u.test(baseSha)
    )
      return false;
    const relative = `${BASELINE_MARKER_DIR}/${baseSha}-${markerSha}.json`;
    const expected: MarkerBaselineReceipt = {
      version: 1,
      runId: run.id,
      ticket: run.ticketOrPr,
      baseSha,
      markerSha,
    };
    if (inventory !== null) {
      const digest = inventory
        .find((entry) => entry.path === `artifacts/${relative}`)
        ?.sha256?.replace(/^sha256:/u, '');
      if (!digest) return false;
      const bytes = await io.readText(path.join(artifactsDir, relative));
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) return false;
      let receipt: unknown;
      try {
        receipt = JSON.parse(bytes);
      } catch {
        return false;
      } // Malformed retained metadata grants no admission.
      return (
        isRecord(receipt) &&
        Object.entries(expected).every(([key, value]) => receipt[key] === value)
      );
    }
    if (!run.slotId) return false;
    const vars = await loadSlotVars(run.slotId);
    if (vars.projectName !== run.project) return false;
    const result = await execArgvOnSlot(
      vars,
      [
        'git',
        '--no-replace-objects',
        'show',
        '--format=%H%x00%P%x00%s%x00',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--unified=0',
        markerSha,
        '--',
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    if (
      result.exitCode !== 0 ||
      !(await isTicketMarkerCommit(result.stdout, baseSha, markerSha, run.ticketOrPr))
    )
      return false;
    await writeAtomicJSON(path.join(path.dirname(run.taskFile), 'artifacts', relative), expected);
    return true;
  }
}
