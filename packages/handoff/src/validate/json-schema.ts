import type { JsonSchema } from '../spec/schemas.js';

/** A single schema violation with a JSON-pointer-style instance path. */
export interface SchemaError {
  path: string;
  message: string;
}

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Shape AND calendar validity, offset included - neither 2026-99-99T99:99:99Z
 * nor an RFC 3339-impossible offset like +99:99 or +24:00 must pass. */
export function isValidDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (!match) return false;
  const [, year, month, day, hours, minutes, seconds, offsetHours, offsetMinutes] =
    match.map(Number);
  if (!Number.isNaN(offsetHours) && (offsetHours > 23 || offsetMinutes > 59)) {
    return false;
  }
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hours <= 23 &&
    minutes <= 59 &&
    seconds <= 59
  );
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value: unknown, type: string): boolean {
  const actual = jsonType(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'integer') return actual === 'integer';
  return actual === type;
}

function checkFormat(value: string, format: string): boolean {
  if (format === 'date-time') return isValidDateTime(value);
  if (format === 'uri') {
    try {
      return Boolean(new URL(value));
    } catch {
      return false;
    }
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/**
 * True iff `value` conforms to `schema`. Used for the schema-composition keywords
 * (`if`) where only pass/fail matters and no errors should be surfaced.
 */
function conforms(value: unknown, schema: JsonSchema): boolean {
  const errors: SchemaError[] = [];
  validateNode(value, schema, '', errors);
  return errors.length === 0;
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaError[],
): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push({
        path: path || '/',
        message: `expected type ${types.join('|')}, got ${jsonType(value)}`,
      });
      return;
    }
  }

  if ('const' in schema && !deepEqual(value, schema.const)) {
    errors.push({ path: path || '/', message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(value, option))) {
    errors.push({
      path: path || '/',
      message: `must be one of ${JSON.stringify(schema.enum)}`,
    });
  }

  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path: path || '/', message: `does not match pattern ${schema.pattern}` });
    }
    if (schema.format !== undefined && !checkFormat(value, schema.format)) {
      errors.push({ path: path || '/', message: `invalid ${schema.format}` });
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path: path || '/', message: `must be >= ${schema.minimum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: path || '/', message: `must have >= ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path: path || '/', message: `must have <= ${schema.maxItems} items` });
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) =>
        validateNode(item, schema.items as JsonSchema, `${path}/${i}`, errors),
      );
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        errors.push({ path: path || '/', message: `missing required property '${key}'` });
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(record)) {
      const propSchema = properties[key];
      if (propSchema !== undefined) {
        validateNode(child, propSchema, `${path}/${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: `${path}/${key}`,
          message: `additional property '${key}' not allowed`,
        });
      } else if (typeof schema.additionalProperties === 'object') {
        validateNode(child, schema.additionalProperties, `${path}/${key}`, errors);
      }
    }
  }

  if (schema.if !== undefined) {
    const branch = conforms(value, schema.if) ? schema.then : schema.else;
    if (branch !== undefined) validateNode(value, branch, path, errors);
  }
}

/** Validate a parsed JSON value against one of the shipped spec schemas. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): SchemaError[] {
  const errors: SchemaError[] = [];
  validateNode(value, schema, '', errors);
  return errors;
}
