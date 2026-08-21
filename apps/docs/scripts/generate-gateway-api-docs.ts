import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';

import { Events, Methods, PROTOCOL_VERSION } from '@farmslot/protocol';

interface DocEntry {
  name: string;
  file: string;
  comment: string;
  properties: Array<{ name: string; optional: boolean; comment: string }>;
}

interface CapabilityMethod {
  method: string;
  category: string;
  safetyTier: string;
  paramsType?: string;
  resultType?: string;
  summary: string;
}

interface CapabilityEvent {
  event: string;
  category: string;
  summary: string;
}

interface GatewayCapabilitiesSnapshot {
  protocolVersion: string;
  methods: CapabilityMethod[];
  events: CapabilityEvent[];
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const protocolSrc = join(repoRoot, 'packages/protocol/src');
const docsOut = join(repoRoot, 'apps/docs/docs/reference/gateway-api.generated.md');

const docs = collectDocs(protocolSrc);
const capabilities = gatewayCapabilitiesSnapshot();

const lines: string[] = [];
lines.push('---');
lines.push('title: Gateway API generated reference (raw)');
lines.push('unlisted: true');
lines.push('---');
lines.push('');
lines.push('# Gateway API generated reference (raw)');
lines.push('');
lines.push(
  'This advanced reference is generated from `@farmslot/protocol` capability metadata plus TSDoc comments on protocol interfaces. Do not edit it by hand. For public onboarding, start with [Gateway API capability surface](./gateway-api.md). This raw table is intentionally unlisted because some low-level methods still have generated summaries while public-safe capability grouping and TSDoc coverage mature.',
);
lines.push('');
lines.push(`Protocol version: \`${capabilities.protocolVersion}\``);
lines.push('');
lines.push('## WebSocket frame shape');
lines.push('');
appendDoc(lines, docs.get('RequestFrame'));
appendDoc(lines, docs.get('ResponseFrame'));
appendDoc(lines, docs.get('EventFrame'));
lines.push('');
lines.push('## Method capabilities');
lines.push('');
lines.push('| Method | Category | Safety | Params | Result | Summary |');
lines.push('| --- | --- | --- | --- | --- | --- |');
for (const method of capabilities.methods) {
  lines.push(
    `| \`${method.method}\` | ${method.category} | ${method.safetyTier} | ${formatType(method.paramsType)} | ${formatType(method.resultType)} | ${escapeCell(method.summary)} |`,
  );
}
lines.push('');
lines.push('## Documented params/results');
lines.push('');
const referencedTypes = new Set<string>();
for (const method of capabilities.methods) {
  if (method.paramsType) referencedTypes.add(method.paramsType);
  if (method.resultType) referencedTypes.add(method.resultType);
}
for (const name of [...referencedTypes].sort()) {
  appendDoc(lines, docs.get(name));
}
lines.push('');
lines.push('## Events');
lines.push('');
lines.push('| Event | Category | Summary |');
lines.push('| --- | --- | --- |');
for (const event of capabilities.events) {
  lines.push(`| \`${event.event}\` | ${event.category} | ${escapeCell(event.summary)} |`);
}

writeFileSync(docsOut, `${lines.join('\n')}\n`);
console.log(`Generated ${relative(repoRoot, docsOut)}`);

function gatewayCapabilitiesSnapshot(): GatewayCapabilitiesSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    methods: Object.values(Methods)
      .filter((method): method is string => typeof method === 'string')
      .sort()
      .map((method) => ({
        method,
        category: method.split('.')[0] ?? 'misc',
        safetyTier: inferSafetyTier(method),
        summary: `${titleCase(method)} gateway method.`,
      })),
    events: Object.values(Events)
      .filter((event): event is string => typeof event === 'string')
      .sort()
      .map((event) => ({
        event,
        category: event.split('.')[0] ?? 'misc',
        summary: `${titleCase(event)} gateway event.`,
      })),
  };
}

function inferSafetyTier(method: string): string {
  if (method.includes('delete') || method.includes('discard') || method.includes('resolve')) {
    return 'high-impact';
  }
  if (
    method.includes('prepare') ||
    method.includes('release') ||
    method.includes('recycle') ||
    method.includes('resume') ||
    method.includes('pause')
  ) {
    return 'lifecycle';
  }
  if (
    method.includes('list') ||
    method.includes('ping') ||
    method.includes('status') ||
    method.includes('doctor') ||
    method.includes('get') ||
    method.includes('read') ||
    method.includes('capabilities') ||
    // History-only pressure read: in-memory rings + freshness, no mutation.
    method === 'resource.pressure.history'
  ) {
    return 'read-only';
  }
  return 'bounded-write';
}

function titleCase(value: string): string {
  return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function collectDocs(root: string): Map<string, DocEntry> {
  const entries = new Map<string, DocEntry>();
  for (const file of walk(root)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const sourceText = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    visit(sourceFile, (node) => {
      if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) return;
      const name = node.name.text;
      const comment = ts.displayPartsToString(
        ts.getJSDocCommentsAndTags(node).flatMap((doc) => (doc.getText ? [] : [])),
      );
      const jsDoc = getJsDocText(node, sourceFile);
      const properties: DocEntry['properties'] = [];
      if (ts.isInterfaceDeclaration(node)) {
        for (const member of node.members) {
          if (!ts.isPropertySignature(member) || !member.name) continue;
          const propertyName = member.name.getText(sourceFile).replace(/^['\"]|['\"]$/g, '');
          properties.push({
            name: propertyName,
            optional: Boolean(member.questionToken),
            comment: getJsDocText(member, sourceFile),
          });
        }
      }
      entries.set(name, {
        name,
        file: relative(repoRoot, file),
        comment: jsDoc || comment,
        properties,
      });
    });
  }
  return entries;
}

function visit(node: ts.Node, cb: (node: ts.Node) => void): void {
  cb(node);
  ts.forEachChild(node, (child) => visit(child, cb));
}

function getJsDocText(node: ts.Node, sourceFile: ts.SourceFile): string {
  const ranges = ts.getJSDocCommentRanges(node, sourceFile.text) ?? [];
  return ranges
    .map((range) => sourceFile.text.slice(range.pos, range.end))
    .map(cleanJsDoc)
    .filter(Boolean)
    .join('\n\n');
}

function cleanJsDoc(raw: string): string {
  return raw
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
    .trim();
}

function appendDoc(lines: string[], entry: DocEntry | undefined): void {
  if (!entry) return;
  lines.push(`### \`${entry.name}\``);
  lines.push('');
  if (entry.comment) {
    lines.push(entry.comment);
    lines.push('');
  }
  lines.push(`Source: \`${entry.file}\``);
  lines.push('');
  if (entry.properties.length) {
    lines.push('| Field | Required | Comment |');
    lines.push('| --- | --- | --- |');
    for (const prop of entry.properties) {
      lines.push(
        `| \`${prop.name}\` | ${prop.optional ? 'no' : 'yes'} | ${escapeCell(prop.comment || '—')} |`,
      );
    }
    lines.push('');
  }
}

function formatType(type: string | undefined): string {
  return type ? `\`${type}\`` : '—';
}

function escapeCell(value: string): string {
  return value
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>')
    .replace(/\|/g, '\\|');
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}
