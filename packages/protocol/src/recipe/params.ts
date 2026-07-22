import { isDeepStrictEqual } from 'node:util';

import {
  addFinding,
  createContext,
  finishResult,
  hasOwn,
  isRecord,
  type MutableValidationContext,
  type RecipeValidationResult,
} from './common.js';

const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);
const REFERENCE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;
const OBJECT_SCHEMA_FIELDS = new Set(['type', 'additionalProperties', 'required', 'properties']);
const PARAM_SCHEMA_FIELDS = new Set([
  'type',
  'description',
  'default',
  'enum',
  'additionalProperties',
  'required',
  'properties',
  'items',
]);

export function validateRecipeParamsSchema(
  schema: unknown,
  options?: { requireClosedRoot?: boolean },
): RecipeValidationResult {
  const ctx = createContext();
  validateObjectSchema(
    ctx,
    schema,
    'paramsSchema',
    OBJECT_SCHEMA_FIELDS,
    true,
    options?.requireClosedRoot !== false,
  );
  return finishResult(ctx);
}

export function applyRecipeParamDefaults(
  params: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  return applyObjectDefaults(params, schema);
}

export function validateRecipeParams(
  params: Record<string, unknown>,
  schema: unknown,
  options?: { allowTemplates?: boolean },
): RecipeValidationResult {
  const ctx = createContext();
  if (!isRecord(schema)) {
    for (const name of Object.keys(params)) {
      addFinding(
        ctx,
        'error',
        'recipe.unknown_param',
        `params.${name}`,
        `Unknown parameter ${name}.`,
      );
    }
    return finishResult(ctx);
  }
  validateObjectValue(ctx, params, schema, 'params', options?.allowTemplates === true);
  return finishResult(ctx);
}

function validateObjectSchema(
  ctx: MutableValidationContext,
  schema: unknown,
  path: string,
  supportedFields: ReadonlySet<string> = OBJECT_SCHEMA_FIELDS,
  exactObjectType = true,
  strictObjectBoundary = false,
): void {
  if (!isRecord(schema)) {
    addFinding(ctx, 'error', 'recipe.invalid_params_schema', path, `${path} must be an object.`);
    return;
  }
  validateSchemaFields(ctx, schema, path, supportedFields);
  if (exactObjectType ? schema.type !== 'object' : !schemaIncludesType(schema.type, 'object')) {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_params_schema_type',
      `${path}.type`,
      `${path}.type must be object.`,
    );
  }
  if (schema.additionalProperties != null && typeof schema.additionalProperties !== 'boolean') {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_params_additional_properties',
      `${path}.additionalProperties`,
      `${path}.additionalProperties must be a boolean.`,
    );
  } else if (exactObjectType && schema.additionalProperties == null) {
    addFinding(
      ctx,
      'error',
      'recipe.missing_params_additional_properties',
      `${path}.additionalProperties`,
      `${path}.additionalProperties must explicitly declare whether unknown properties are allowed.`,
    );
  } else if (strictObjectBoundary && schema.additionalProperties !== false) {
    addFinding(
      ctx,
      'error',
      'recipe.non_strict_params_schema',
      `${path}.additionalProperties`,
      `${path}.additionalProperties must be false.`,
    );
  }
  if (schema.properties != null && !isRecord(schema.properties)) {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_params_properties',
      `${path}.properties`,
      `${path}.properties must be an object.`,
    );
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (!REFERENCE_SEGMENT_PATTERN.test(name)) {
      addFinding(
        ctx,
        'error',
        'recipe.invalid_param_name',
        `${path}.properties.${name}`,
        `${name} must contain only letters, numbers, underscores, or hyphens.`,
      );
    }
    validatePropertySchema(ctx, propertySchema, `${path}.properties.${name}`);
  }
  if (schema.required != null && !Array.isArray(schema.required)) {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_params_required',
      `${path}.required`,
      `${path}.required must be an array of unique property names.`,
    );
  } else if (Array.isArray(schema.required)) {
    const seen = new Set<string>();
    schema.required.forEach((name, index) => {
      const requiredPath = `${path}.required[${index}]`;
      if (typeof name !== 'string' || name.trim() === '') {
        addFinding(
          ctx,
          'error',
          'recipe.invalid_params_required_name',
          requiredPath,
          `${requiredPath} must be a non-empty string.`,
        );
      } else if (seen.has(name)) {
        addFinding(
          ctx,
          'error',
          'recipe.duplicate_params_required_name',
          requiredPath,
          `${name} appears more than once in ${path}.required.`,
        );
      } else if (!hasOwn(properties, name)) {
        addFinding(
          ctx,
          'error',
          'recipe.unknown_params_required_name',
          requiredPath,
          `${name} is required but is not declared in ${path}.properties.`,
        );
      }
      if (typeof name === 'string') seen.add(name);
    });
  }
}

function validatePropertySchema(
  ctx: MutableValidationContext,
  schema: unknown,
  path: string,
): void {
  if (!isRecord(schema)) {
    addFinding(ctx, 'error', 'recipe.invalid_param_schema', path, `${path} must be an object.`);
    return;
  }
  validateSchemaFields(ctx, schema, path, PARAM_SCHEMA_FIELDS);
  if (!isSupportedParamType(schema.type)) {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_param_type',
      `${path}.type`,
      `${path}.type must be a supported type or a non-empty array of supported types.`,
    );
  }
  if (schema.description != null && typeof schema.description !== 'string') {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_param_description',
      `${path}.description`,
      `${path}.description must be a string.`,
    );
  }
  if (schema.enum != null) {
    const enumValues = schema.enum;
    if (!Array.isArray(enumValues) || enumValues.length === 0) {
      addFinding(
        ctx,
        'error',
        'recipe.invalid_param_enum',
        `${path}.enum`,
        `${path}.enum must be a non-empty array.`,
      );
    } else {
      enumValues.forEach((value, index) => {
        if (!valueMatchesType(value, schema.type)) {
          addFinding(
            ctx,
            'error',
            'recipe.invalid_param_enum_value',
            `${path}.enum[${index}]`,
            `${path}.enum[${index}] does not match type ${String(schema.type)}.`,
          );
        } else {
          validateNestedStructuredValue(ctx, value, schema, `${path}.enum[${index}]`);
        }
        if (enumValues.slice(0, index).some((entry) => isDeepStrictEqual(entry, value))) {
          addFinding(
            ctx,
            'error',
            'recipe.duplicate_param_enum_value',
            `${path}.enum[${index}]`,
            `${path}.enum values must be unique.`,
          );
        }
      });
    }
  }
  if (hasOwn(schema, 'default')) {
    if (!valueMatchesType(schema.default, schema.type)) {
      addFinding(
        ctx,
        'error',
        'recipe.invalid_param_default_type',
        `${path}.default`,
        `${path}.default does not match type ${String(schema.type)}.`,
      );
    } else if (
      Array.isArray(schema.enum) &&
      !schema.enum.some((entry) => isDeepStrictEqual(entry, schema.default))
    ) {
      addFinding(
        ctx,
        'error',
        'recipe.invalid_param_default_enum',
        `${path}.default`,
        `${path}.default must be one of ${path}.enum.`,
      );
    } else {
      validateNestedStructuredValue(ctx, schema.default, schema, `${path}.default`);
    }
  }
  if (schemaIncludesType(schema.type, 'object'))
    validateObjectSchema(ctx, schema, path, PARAM_SCHEMA_FIELDS, false);
  if (schemaIncludesType(schema.type, 'array')) {
    if (schema.items == null) {
      addFinding(
        ctx,
        'error',
        'recipe.missing_param_items',
        `${path}.items`,
        `${path}.items is required for array parameters.`,
      );
    } else {
      validatePropertySchema(ctx, schema.items, `${path}.items`);
    }
  }
}

function validateNestedStructuredValue(
  ctx: MutableValidationContext,
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): void {
  if (schemaIncludesType(schema.type, 'object') && isRecord(value)) {
    validateObjectValue(ctx, value, schema, path);
  }
  if (schemaIncludesType(schema.type, 'array') && Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateParamValue(ctx, entry, schema.items, `${path}[${index}]`),
    );
  }
}

function validateSchemaFields(
  ctx: MutableValidationContext,
  schema: Record<string, unknown>,
  path: string,
  supported: ReadonlySet<string>,
): void {
  for (const field of Object.keys(schema)) {
    if (supported.has(field)) continue;
    addFinding(
      ctx,
      'error',
      'recipe.unknown_param_schema_field',
      `${path}.${field}`,
      `${path}.${field} is not a supported parameter schema field.`,
    );
  }
}

function applyObjectDefaults(
  value: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  for (const [key, entry] of Object.entries(value)) {
    defineOwn(resolved, key, applyNestedDefaults(entry, properties[key]));
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!hasOwn(resolved, key) && isRecord(propertySchema) && hasOwn(propertySchema, 'default')) {
      defineOwn(resolved, key, applyNestedDefaults(propertySchema.default, propertySchema));
    }
  }
  return resolved;
}

function applyNestedDefaults(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value;
  if (schemaIncludesType(schema.type, 'object') && isRecord(value))
    return applyObjectDefaults(value, schema);
  if (schemaIncludesType(schema.type, 'array') && Array.isArray(value)) {
    return value.map((entry) => applyNestedDefaults(entry, schema.items));
  }
  return value;
}

function validateObjectValue(
  ctx: MutableValidationContext,
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
  allowTemplates = false,
): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === 'string' && !hasOwn(value, name)) {
        addFinding(
          ctx,
          'error',
          'recipe.missing_param',
          `${path}.${name}`,
          `Missing required parameter ${name}.`,
        );
      }
    }
  }
  for (const [name, parameter] of Object.entries(value)) {
    const propertySchema = properties[name];
    if (propertySchema == null) {
      if (schema.additionalProperties === false) {
        addFinding(
          ctx,
          'error',
          'recipe.unknown_param',
          `${path}.${name}`,
          `Unknown parameter ${name}.`,
        );
      }
      continue;
    }
    validateParamValue(ctx, parameter, propertySchema, `${path}.${name}`, allowTemplates);
  }
}

function validateParamValue(
  ctx: MutableValidationContext,
  value: unknown,
  schema: unknown,
  path: string,
  allowTemplates = false,
): void {
  if (!isRecord(schema)) return;
  if (
    allowTemplates &&
    (isExactRecipeReference(value) ||
      (schemaIncludesType(schema.type, 'string') && isInterpolatedRecipeString(value)))
  )
    return;
  if (!valueMatchesType(value, schema.type)) {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_param_value_type',
      path,
      `${path} must match type ${String(schema.type)}.`,
    );
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => isDeepStrictEqual(entry, value))) {
    addFinding(
      ctx,
      'error',
      'recipe.invalid_param_value_enum',
      path,
      `${path} must be one of ${JSON.stringify(schema.enum)}.`,
    );
  }
  if (schemaIncludesType(schema.type, 'object') && isRecord(value))
    validateObjectValue(ctx, value, schema, path, allowTemplates);
  if (schemaIncludesType(schema.type, 'array') && Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateParamValue(ctx, entry, schema.items, `${path}[${index}]`, allowTemplates),
    );
  }
}

function isExactRecipeReference(value: unknown): value is string {
  return typeof value === 'string' && /^\{\{(?:params|outputs)\.[A-Za-z0-9_.-]+\}\}$/u.test(value);
}

function isInterpolatedRecipeString(value: unknown): value is string {
  return typeof value === 'string' && /\{\{(?:params|outputs)\.[A-Za-z0-9_.-]+\}\}/u.test(value);
}

function valueMatchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((entry) => valueMatchesType(value, entry));
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

function isSupportedParamType(value: unknown): boolean {
  if (typeof value === 'string') return PARAM_TYPES.has(value);
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && PARAM_TYPES.has(entry)) &&
    new Set(value).size === value.length
  );
}

function schemaIncludesType(value: unknown, type: string): boolean {
  return value === type || (Array.isArray(value) && value.includes(type));
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
