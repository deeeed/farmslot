// github-jq.ts — the jq subset that `gh --jq` callers use, evaluated in-process.
// Output formatting follows gh 2.98 (go-gh pkg/jq EvaluateFormatted over gojq):
// strings print raw, null prints an empty line, integral numbers print without
// decimals, other numbers with two, and arrays/objects as Go json.Marshal does.
// An expression outside the subset fails at compile time, never silently.

export type JqValue = null | boolean | number | string | JqValue[] | { [key: string]: JqValue };
type JqObject = { [key: string]: JqValue };

type JqNode =
  | { kind: 'identity' }
  | { kind: 'literal'; value: JqValue }
  | { kind: 'string'; parts: Array<string | JqNode> }
  | { kind: 'field'; target: JqNode; name: string }
  | { kind: 'index'; target: JqNode; index: JqNode }
  | { kind: 'slice'; target: JqNode; from: JqNode | null; to: JqNode | null }
  | { kind: 'iterate'; target: JqNode }
  | { kind: 'try'; body: JqNode }
  | { kind: 'pipe'; left: JqNode; right: JqNode }
  | { kind: 'comma'; left: JqNode; right: JqNode }
  | { kind: 'alternative'; left: JqNode; right: JqNode }
  | { kind: 'and' | 'or'; left: JqNode; right: JqNode }
  | { kind: 'compare'; op: '==' | '!='; left: JqNode; right: JqNode }
  | { kind: 'negate'; body: JqNode }
  | { kind: 'array'; body: JqNode | null }
  | { kind: 'object'; entries: Array<{ key: JqNode; value: JqNode }> }
  | { kind: 'if'; cond: JqNode; then: JqNode; otherwise: JqNode | null }
  | { kind: 'call'; name: 'select' | 'empty' | 'not' | 'length'; arg: JqNode | null }
  | { kind: 'format'; name: 'tsv' | 'json' };

/** A jq runtime error; gh exits non-zero with it, so callers see a failed request. */
export class GitHubJqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubJqError';
  }
}

export interface GitHubJqFilter {
  readonly expression: string;
  run(input: JqValue): JqValue[];
}

// ─── Lexer ───

type Token =
  | { type: 'punct'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'field'; value: string }
  | { type: 'number'; value: number }
  | { type: 'string'; parts: Array<string | JqNode> }
  | { type: 'format'; value: string }
  | { type: 'eof' };

const PUNCTUATION = ['//', '==', '!=', '|', ',', '.', '[', ']', '(', ')', '{', '}', ':', '?', '-'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const { parts, end } = readString(source, i);
      tokens.push({ type: 'string', parts });
      i = end;
      continue;
    }
    if (ch === '@') {
      const match = /^@[A-Za-z0-9_]+/.exec(source.slice(i));
      if (!match) throw new GitHubJqError(`jq: unsupported syntax at ${i}`);
      tokens.push({ type: 'format', value: match[0].slice(1) });
      i += match[0].length;
      continue;
    }
    if (ch === '.' && /[A-Za-z_]/.test(source[i + 1] ?? '')) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i + 1))!;
      tokens.push({ type: 'field', value: match[0] });
      i += 1 + match[0].length;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(i))!;
      tokens.push({ type: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ type: 'ident', value: match[0] });
      i += match[0].length;
      continue;
    }
    const punct = PUNCTUATION.find((candidate) => source.startsWith(candidate, i));
    if (!punct) throw new GitHubJqError(`jq: unsupported syntax "${ch}" at ${i}`);
    tokens.push({ type: 'punct', value: punct });
    i += punct.length;
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

const STRING_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function readString(source: string, start: number): { parts: Array<string | JqNode>; end: number } {
  const parts: Array<string | JqNode> = [];
  let text = '';
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      if (text || parts.length === 0) parts.push(text);
      return { parts, end: i + 1 };
    }
    if (ch !== '\\') {
      text += ch;
      i++;
      continue;
    }
    const next = source[i + 1];
    if (next === '(') {
      const close = matchingParen(source, i + 1);
      if (text) parts.push(text);
      text = '';
      parts.push(parse(source.slice(i + 2, close)));
      i = close + 1;
    } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
      text += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
      i += 6;
    } else if (next !== undefined && next in STRING_ESCAPES) {
      text += STRING_ESCAPES[next];
      i += 2;
    } else {
      throw new GitHubJqError(`jq: invalid escape at ${i}`);
    }
  }
  throw new GitHubJqError('jq: unterminated string');
}

function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      i = readString(source, i).end - 1;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && --depth === 0) {
      return i;
    }
  }
  throw new GitHubJqError('jq: unterminated interpolation');
}

// ─── Parser (jq precedence: | , // or and comparison unary/postfix) ───

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parseProgram(): JqNode {
    const node = this.pipe();
    if (this.peek().type !== 'eof') throw this.unexpected();
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.type === 'punct' && token.value === value;
  }

  private isKeyword(value: string): boolean {
    const token = this.peek();
    return token.type === 'ident' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw this.unexpected();
    this.pos++;
  }

  private expectKeyword(value: string): void {
    if (!this.isKeyword(value)) throw this.unexpected();
    this.pos++;
  }

  private unexpected(): GitHubJqError {
    const token = this.peek();
    const shown = 'value' in token ? String(token.value) : token.type;
    return new GitHubJqError(`jq: unsupported or unexpected token "${shown}"`);
  }

  private pipe(): JqNode {
    const left = this.comma();
    if (!this.isPunct('|')) return left;
    this.pos++;
    return { kind: 'pipe', left, right: this.pipe() };
  }

  private comma(): JqNode {
    let left = this.alternative();
    while (this.isPunct(',')) {
      this.pos++;
      left = { kind: 'comma', left, right: this.alternative() };
    }
    return left;
  }

  private alternative(): JqNode {
    const left = this.or();
    if (!this.isPunct('//')) return left;
    this.pos++;
    return { kind: 'alternative', left, right: this.alternative() };
  }

  private or(): JqNode {
    let left = this.and();
    while (this.isKeyword('or')) {
      this.pos++;
      left = { kind: 'or', left, right: this.and() };
    }
    return left;
  }

  private and(): JqNode {
    let left = this.comparison();
    while (this.isKeyword('and')) {
      this.pos++;
      left = { kind: 'and', left, right: this.comparison() };
    }
    return left;
  }

  private comparison(): JqNode {
    const left = this.unary();
    for (const op of ['==', '!='] as const) {
      if (this.isPunct(op)) {
        this.pos++;
        return { kind: 'compare', op, left, right: this.unary() };
      }
    }
    return left;
  }

  private unary(): JqNode {
    if (this.isPunct('-')) {
      this.pos++;
      return { kind: 'negate', body: this.postfix() };
    }
    return this.postfix();
  }

  private postfix(): JqNode {
    let node = this.term();
    for (;;) {
      const token = this.peek();
      if (token.type === 'field') {
        this.pos++;
        node = { kind: 'field', target: node, name: token.value };
      } else if (this.isPunct('.') && this.tokens[this.pos + 1]?.type === 'string') {
        this.pos++;
        node = { kind: 'field', target: node, name: this.literalString(this.next()) };
      } else if (this.isPunct('.') && this.isBracketAhead()) {
        this.pos++;
      } else if (this.isPunct('[')) {
        node = this.bracketSuffix(node);
      } else if (this.isPunct('?')) {
        this.pos++;
        node = { kind: 'try', body: node };
      } else {
        return node;
      }
    }
  }

  private isBracketAhead(): boolean {
    const after = this.tokens[this.pos + 1];
    return after?.type === 'punct' && after.value === '[';
  }

  private bracketSuffix(target: JqNode): JqNode {
    this.expectPunct('[');
    if (this.isPunct(']')) {
      this.pos++;
      return { kind: 'iterate', target };
    }
    if (this.isPunct(':')) {
      this.pos++;
      const to = this.pipe();
      this.expectPunct(']');
      return { kind: 'slice', target, from: null, to };
    }
    const index = this.pipe();
    if (this.isPunct(':')) {
      this.pos++;
      const to = this.isPunct(']') ? null : this.pipe();
      this.expectPunct(']');
      return { kind: 'slice', target, from: index, to };
    }
    this.expectPunct(']');
    return { kind: 'index', target, index };
  }

  private literalString(token: Token): string {
    if (token.type !== 'string' || token.parts.some((part) => typeof part !== 'string'))
      throw new GitHubJqError('jq: field names must be plain strings');
    return token.parts.join('');
  }

  private term(): JqNode {
    const token = this.next();
    switch (token.type) {
      case 'field':
        return { kind: 'field', target: { kind: 'identity' }, name: token.value };
      case 'number':
        return { kind: 'literal', value: token.value };
      case 'string':
        return token.parts.every((part) => typeof part === 'string')
          ? { kind: 'literal', value: token.parts.join('') }
          : { kind: 'string', parts: token.parts };
      case 'format':
        if (token.value !== 'tsv' && token.value !== 'json')
          throw new GitHubJqError(`jq: unsupported format @${token.value}`);
        return { kind: 'format', name: token.value };
      case 'ident':
        return this.identifierTerm(token.value);
      case 'punct':
        return this.punctTerm(token.value);
      default:
        this.pos--;
        throw this.unexpected();
    }
  }

  private punctTerm(value: string): JqNode {
    if (value === '.') {
      if (this.peek().type === 'string')
        return {
          kind: 'field',
          target: { kind: 'identity' },
          name: this.literalString(this.next()),
        };
      return { kind: 'identity' };
    }
    if (value === '(') {
      const inner = this.pipe();
      this.expectPunct(')');
      return inner;
    }
    if (value === '[') {
      if (this.isPunct(']')) {
        this.pos++;
        return { kind: 'array', body: null };
      }
      const body = this.pipe();
      this.expectPunct(']');
      return { kind: 'array', body };
    }
    if (value === '{') return this.objectTerm();
    this.pos--;
    throw this.unexpected();
  }

  private identifierTerm(name: string): JqNode {
    if (name === 'null') return { kind: 'literal', value: null };
    if (name === 'true') return { kind: 'literal', value: true };
    if (name === 'false') return { kind: 'literal', value: false };
    if (name === 'if') return this.ifTerm();
    if (name === 'select') {
      this.expectPunct('(');
      const arg = this.pipe();
      this.expectPunct(')');
      return { kind: 'call', name, arg };
    }
    if (name === 'empty' || name === 'not' || name === 'length')
      return { kind: 'call', name, arg: null };
    this.pos--;
    throw this.unexpected();
  }

  private ifTerm(): JqNode {
    const cond = this.pipe();
    this.expectKeyword('then');
    const then = this.pipe();
    let otherwise: JqNode | null = null;
    if (this.isKeyword('elif')) {
      this.pos++;
      otherwise = this.ifTerm();
      return { kind: 'if', cond, then, otherwise };
    }
    if (this.isKeyword('else')) {
      this.pos++;
      otherwise = this.pipe();
    }
    this.expectKeyword('end');
    return { kind: 'if', cond, then, otherwise };
  }

  private objectTerm(): JqNode {
    const entries: Array<{ key: JqNode; value: JqNode }> = [];
    while (!this.isPunct('}')) {
      if (entries.length > 0) this.expectPunct(',');
      const token = this.next();
      let key: JqNode;
      let shorthand: JqNode;
      if (token.type === 'ident') {
        key = { kind: 'literal', value: token.value };
        shorthand = { kind: 'field', target: { kind: 'identity' }, name: token.value };
      } else if (token.type === 'string') {
        const name = this.literalString(token);
        key = { kind: 'literal', value: name };
        shorthand = { kind: 'field', target: { kind: 'identity' }, name };
      } else if (token.type === 'punct' && token.value === '(') {
        key = this.pipe();
        this.expectPunct(')');
        this.expectPunct(':');
        entries.push({ key, value: this.objectValue() });
        continue;
      } else {
        this.pos--;
        throw this.unexpected();
      }
      if (this.isPunct(':')) {
        this.pos++;
        entries.push({ key, value: this.objectValue() });
      } else {
        entries.push({ key, value: shorthand });
      }
    }
    this.expectPunct('}');
    return { kind: 'object', entries };
  }

  /** jq ObjVal: unary/postfix terms joined by pipes; commas end the entry. */
  private objectValue(): JqNode {
    const left = this.unary();
    if (!this.isPunct('|')) return left;
    this.pos++;
    return { kind: 'pipe', left, right: this.objectValue() };
  }
}

function parse(source: string): JqNode {
  return new Parser(tokenize(source)).parseProgram();
}

// ─── Evaluation ───

function typeName(value: JqValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

function truthy(value: JqValue): boolean {
  return value !== null && value !== false;
}

function isObject(value: JqValue): value is JqObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a: JqValue, b: JqValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/** Code-point slicing, as jq and gojq slice strings. */
function sliceCodePoints(text: string, from: number, to: number): string {
  const points = Array.from(text);
  return points.slice(from, to).join('');
}

function sliceBounds(length: number, from: JqValue, to: JqValue): [number, number] {
  const resolve = (value: JqValue, fallback: number, round: (n: number) => number) => {
    if (value === null) return fallback;
    if (typeof value !== 'number') throw new GitHubJqError('jq: slice indices must be numbers');
    const n = round(value);
    return Math.min(length, Math.max(0, n < 0 ? length + n : n));
  };
  return [resolve(from, 0, Math.floor), resolve(to, length, Math.ceil)];
}

function* evaluate(node: JqNode, input: JqValue): Generator<JqValue> {
  switch (node.kind) {
    case 'identity':
      yield input;
      return;
    case 'literal':
      yield node.value;
      return;
    case 'string':
      yield* interpolate(node.parts, 0, input, '');
      return;
    case 'field':
      for (const target of evaluate(node.target, input)) {
        if (target === null) yield null;
        else if (isObject(target)) yield target[node.name] ?? null;
        else throw new GitHubJqError(`expected an object but got: ${typeName(target)}`);
      }
      return;
    case 'index':
      for (const target of evaluate(node.target, input)) {
        for (const index of evaluate(node.index, input)) yield indexValue(target, index);
      }
      return;
    case 'slice':
      for (const target of evaluate(node.target, input)) {
        for (const to of node.to ? evaluate(node.to, input) : [null]) {
          for (const from of node.from ? evaluate(node.from, input) : [null]) {
            yield sliceValue(target, from, to);
          }
        }
      }
      return;
    case 'iterate':
      for (const target of evaluate(node.target, input)) {
        if (Array.isArray(target)) yield* target;
        else if (isObject(target)) yield* Object.values(target);
        else throw new GitHubJqError(`cannot iterate over: ${typeName(target)}`);
      }
      return;
    case 'try':
      try {
        yield* evaluate(node.body, input);
      } catch (error) {
        // `?` suppresses jq runtime errors only; programming errors still surface.
        if (!(error instanceof GitHubJqError)) throw error;
      }
      return;
    case 'pipe':
      for (const value of evaluate(node.left, input)) yield* evaluate(node.right, value);
      return;
    case 'comma':
      yield* evaluate(node.left, input);
      yield* evaluate(node.right, input);
      return;
    case 'alternative': {
      let produced = false;
      try {
        for (const value of evaluate(node.left, input)) {
          if (!truthy(value)) continue;
          produced = true;
          yield value;
        }
      } catch (error) {
        // jq's `a // b` treats an erroring left side as producing no value.
        if (!(error instanceof GitHubJqError)) throw error;
      }
      if (!produced) yield* evaluate(node.right, input);
      return;
    }
    case 'and':
    case 'or':
      for (const left of evaluate(node.left, input)) {
        if (node.kind === 'and' ? !truthy(left) : truthy(left)) {
          yield node.kind === 'or';
          continue;
        }
        for (const right of evaluate(node.right, input)) yield truthy(right);
      }
      return;
    case 'compare':
      for (const right of evaluate(node.right, input)) {
        for (const left of evaluate(node.left, input)) {
          const equal = deepEqual(left, right);
          yield node.op === '==' ? equal : !equal;
        }
      }
      return;
    case 'negate':
      for (const value of evaluate(node.body, input)) {
        if (typeof value !== 'number') throw new GitHubJqError(`cannot negate: ${typeName(value)}`);
        yield -value;
      }
      return;
    case 'array':
      yield node.body ? Array.from(evaluate(node.body, input)) : [];
      return;
    case 'object':
      yield* buildObjects(node.entries, 0, input, {});
      return;
    case 'if':
      for (const cond of evaluate(node.cond, input)) {
        if (truthy(cond)) yield* evaluate(node.then, input);
        else if (node.otherwise) yield* evaluate(node.otherwise, input);
        else yield input;
      }
      return;
    case 'call':
      yield* evaluateCall(node.name, node.arg, input);
      return;
    case 'format':
      yield node.name === 'json' ? encodeGoJson(input, GOJQ_ENCODING) : formatTsv(input);
      return;
  }
}

function* evaluateCall(
  name: 'select' | 'empty' | 'not' | 'length',
  arg: JqNode | null,
  input: JqValue,
): Generator<JqValue> {
  if (name === 'select') {
    for (const cond of evaluate(arg!, input)) if (truthy(cond)) yield input;
  } else if (name === 'not') {
    yield !truthy(input);
  } else if (name === 'length') {
    if (input === null) yield 0;
    else if (typeof input === 'string') yield Array.from(input).length;
    else if (Array.isArray(input)) yield input.length;
    else if (isObject(input)) yield Object.keys(input).length;
    else if (typeof input === 'number') yield Math.abs(input);
    else throw new GitHubJqError(`${typeName(input)} has no length`);
  }
}

function indexValue(target: JqValue, index: JqValue): JqValue {
  if (target === null) return null;
  if (Array.isArray(target) && typeof index === 'number') {
    const i = Math.floor(index);
    return target[i < 0 ? target.length + i : i] ?? null;
  }
  if (isObject(target) && typeof index === 'string') return target[index] ?? null;
  throw new GitHubJqError(`cannot index ${typeName(target)} with ${typeName(index)}`);
}

function sliceValue(target: JqValue, from: JqValue, to: JqValue): JqValue {
  if (target === null) return null;
  if (typeof target === 'string') {
    const length = Array.from(target).length;
    const [start, end] = sliceBounds(length, from, to);
    return start >= end ? '' : sliceCodePoints(target, start, end);
  }
  if (Array.isArray(target)) {
    const [start, end] = sliceBounds(target.length, from, to);
    return start >= end ? [] : target.slice(start, end);
  }
  throw new GitHubJqError(`cannot slice ${typeName(target)}`);
}

function* interpolate(
  parts: Array<string | JqNode>,
  i: number,
  input: JqValue,
  prefix: string,
): Generator<JqValue> {
  if (i === parts.length) {
    yield prefix;
    return;
  }
  const part = parts[i];
  if (typeof part === 'string') {
    yield* interpolate(parts, i + 1, input, prefix + part);
    return;
  }
  for (const value of evaluate(part, input)) {
    const text = typeof value === 'string' ? value : encodeGoJson(value, GOJQ_ENCODING);
    yield* interpolate(parts, i + 1, input, prefix + text);
  }
}

function* buildObjects(
  entries: Array<{ key: JqNode; value: JqNode }>,
  i: number,
  input: JqValue,
  partial: JqObject,
): Generator<JqValue> {
  if (i === entries.length) {
    yield { ...partial };
    return;
  }
  for (const key of evaluate(entries[i].key, input)) {
    if (typeof key !== 'string')
      throw new GitHubJqError(`expected a string for object key but got: ${typeName(key)}`);
    for (const value of evaluate(entries[i].value, input)) {
      yield* buildObjects(entries, i + 1, input, { ...partial, [key]: value });
    }
  }
}

const TSV_ESCAPES: Record<string, string> = {
  '\t': '\\t',
  '\r': '\\r',
  '\n': '\\n',
  '\\': '\\\\',
  '\0': '\\0',
};

function formatTsv(input: JqValue): string {
  if (!Array.isArray(input)) throw new GitHubJqError(`${typeName(input)} cannot be tsv-formatted`);
  return input
    .map((value) => {
      if (typeof value === 'string') return value.replace(/[\t\r\n\\\0]/g, (ch) => TSV_ESCAPES[ch]);
      if (value !== null && typeof value === 'object')
        throw new GitHubJqError(`${typeName(value)} is not valid in a tsv row`);
      return value === null ? '' : encodeGoJson(value, GOJQ_ENCODING);
    })
    .join('\t');
}

// ─── JSON encodings (gojq for @json/interpolation, Go encoding/json for output) ───

export interface GoJsonEncoding {
  /** Go json.Marshal escapes <, >, & and U+2028/U+2029; gojq and SetEscapeHTML(false) do not. */
  escapeHtml: boolean;
  /** gojq writes \b and \f; Go encoding/json writes \u0008 and \u000c. */
  shortControlEscapes: boolean;
}

const GOJQ_ENCODING: GoJsonEncoding = { escapeHtml: false, shortControlEscapes: true };
/** go-gh prettyEncoder: json.Marshal for non-scalar jq results. */
export const GO_MARSHAL_ENCODING: GoJsonEncoding = { escapeHtml: true, shortControlEscapes: false };
/** gh's --json exporter: json.Encoder with SetEscapeHTML(false). */
export const GO_EXPORT_ENCODING: GoJsonEncoding = { escapeHtml: false, shortControlEscapes: false };

const goStructs = new WeakSet<object>();

/** Mark an object gh encodes from a Go struct: its keys keep declaration order, unsorted. */
export function goStruct<T extends JqObject>(value: T): T {
  goStructs.add(value);
  return value;
}

const HEX = '0123456789abcdef';

function encodeString(text: string, encoding: GoJsonEncoding): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (encoding.shortControlEscapes && ch === '\b') out += '\\b';
    else if (encoding.shortControlEscapes && ch === '\f') out += '\\f';
    else if (
      code < 0x20 ||
      (encoding.escapeHtml && (ch === '<' || ch === '>' || ch === '&')) ||
      (encoding.escapeHtml && (code === 0x2028 || code === 0x2029))
    )
      out += `\\u${HEX[(code >> 12) & 15]}${HEX[(code >> 8) & 15]}${HEX[(code >> 4) & 15]}${HEX[code & 15]}`;
    else out += ch;
  }
  return `${out}"`;
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) return 'null';
  return String(value);
}

/** Go-flavoured JSON: map keys sorted (struct keys in order), compact, Go's string escaping. */
export function encodeGoJson(value: JqValue, encoding: GoJsonEncoding): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'string') return encodeString(value, encoding);
  if (Array.isArray(value))
    return `[${value.map((item) => encodeGoJson(item, encoding)).join(',')}]`;
  const keys = goStructs.has(value)
    ? Object.keys(value)
    : Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((key) => `${encodeString(key, encoding)}:${encodeGoJson(value[key], encoding)}`).join(',')}}`;
}

/** go-gh jsonScalarToString, else prettyEncoder (json.Marshal); one result per line. */
export function formatJqResult(value: JqValue): string {
  if (typeof value === 'string') return value;
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number')
    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
  return encodeGoJson(value, GO_MARSHAL_ENCODING);
}

const compiled = new Map<string, GitHubJqFilter>();

/** Parse once per distinct expression; the set is small and fixed by gateway source. */
export function compileGitHubJq(expression: string): GitHubJqFilter {
  const existing = compiled.get(expression);
  if (existing) return existing;
  const ast = parse(expression);
  const filter: GitHubJqFilter = {
    expression,
    run: (input) => Array.from(evaluate(ast, input)),
  };
  // Expressions come from gateway source, so this stays small; the bound is a backstop.
  if (compiled.size >= 256) compiled.clear();
  compiled.set(expression, filter);
  return filter;
}

/** Apply a filter to one JSON document and render it as `gh --jq` writes stdout. */
export function runGitHubJq(expression: string, input: JqValue): string {
  return compileGitHubJq(expression)
    .run(input)
    .map((value) => `${formatJqResult(value)}\n`)
    .join('');
}
