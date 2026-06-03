import {
  addFinding,
  createContext,
  finishResult,
  isNonEmptyString,
  isRecord,
  type MutableValidationContext,
  OFFICIAL_ACTION_SET,
  RECIPE_PROTOCOL_SCHEMA_VERSION,
  type RecipeValidationResult,
} from './common.js';

export function getRecipeActionManifestActionNames(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  const actionNames = new Set<string>();
  if (Array.isArray(manifest.supported_official_actions)) {
    for (const action of manifest.supported_official_actions) {
      if (isNonEmptyString(action)) actionNames.add(action);
    }
  }
  if (Array.isArray(manifest.custom_actions)) {
    for (const action of manifest.custom_actions) {
      if (isRecord(action) && isNonEmptyString(action.name)) actionNames.add(action.name);
    }
  }
  return [...actionNames].sort();
}

function validateActionCatalogEntry(
  ctx: MutableValidationContext,
  entry: unknown,
  path: string,
  expectedAction?: string,
): void {
  if (!isRecord(entry)) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_action_metadata',
      path,
      `${path} must be an object.`,
    );
    return;
  }

  for (const stringField of [
    'description',
    'when_to_use',
    'avoid_when',
    'proof_effect',
    'safety_notes',
  ]) {
    const value = entry[stringField];
    if (value != null && typeof value !== 'string') {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_metadata_field',
        `${path}.${stringField}`,
        `${path}.${stringField} must be a string when present.`,
      );
    }
  }

  if (entry.schema != null && !isRecord(entry.schema)) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_schema',
      `${path}.schema`,
      `${path}.schema must be a JSON Schema object when present.`,
    );
  }

  if (entry.examples == null) return;
  if (!Array.isArray(entry.examples)) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_examples',
      `${path}.examples`,
      `${path}.examples must be an array when present.`,
    );
    return;
  }

  entry.examples.forEach((example, index) => {
    const examplePath = `${path}.examples[${index}]`;
    if (!isRecord(example)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_example',
        examplePath,
        `${examplePath} must be an object.`,
      );
      return;
    }
    if (example.description != null && typeof example.description !== 'string') {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_example_description',
        `${examplePath}.description`,
        `${examplePath}.description must be a string when present.`,
      );
    }
    if (!isRecord(example.node)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_example_node',
        `${examplePath}.node`,
        `${examplePath}.node must be an object.`,
      );
      return;
    }
    if (!isNonEmptyString(example.node.action)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_example_action',
        `${examplePath}.node.action`,
        `${examplePath}.node.action must be a non-empty string.`,
      );
    } else if (expectedAction && example.node.action !== expectedAction) {
      addFinding(
        ctx,
        'error',
        'action_manifest.example_action_mismatch',
        `${examplePath}.node.action`,
        `Example action ${example.node.action} must match declared action ${expectedAction}.`,
      );
    }
  });
}

export function validateRecipeActionManifestDocument(manifest: unknown): RecipeValidationResult {
  const ctx = createContext();
  if (!isRecord(manifest)) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_document',
      '$',
      'Recipe action manifest must be a JSON object.',
    );
    return finishResult(ctx);
  }

  if (manifest.runner_protocol_version !== RECIPE_PROTOCOL_SCHEMA_VERSION) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_runner_protocol_version',
      'runner_protocol_version',
      `runner_protocol_version must equal ${RECIPE_PROTOCOL_SCHEMA_VERSION}.`,
    );
  }

  if (manifest.action_registry_version !== RECIPE_PROTOCOL_SCHEMA_VERSION) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_action_registry_version',
      'action_registry_version',
      `action_registry_version must equal ${RECIPE_PROTOCOL_SCHEMA_VERSION}.`,
    );
  }

  const declaredActions = new Set<string>();
  const officialActions = manifest.supported_official_actions;
  if (!Array.isArray(officialActions) || officialActions.length === 0) {
    addFinding(
      ctx,
      'error',
      'action_manifest.invalid_supported_official_actions',
      'supported_official_actions',
      'supported_official_actions must be a non-empty array.',
    );
  } else {
    officialActions.forEach((action, index) => {
      const path = `supported_official_actions[${index}]`;
      if (!isNonEmptyString(action)) {
        addFinding(
          ctx,
          'error',
          'action_manifest.invalid_supported_action',
          path,
          `${path} must be a non-empty string.`,
        );
        return;
      }
      if (!OFFICIAL_ACTION_SET.has(action)) {
        addFinding(
          ctx,
          'error',
          'action_manifest.unknown_official_action',
          path,
          `${action} is not in the Farmslot v1 official action registry.`,
        );
      }
      if (declaredActions.has(action)) {
        addFinding(
          ctx,
          'error',
          'action_manifest.duplicate_action',
          path,
          `${action} is declared more than once.`,
        );
      }
      declaredActions.add(action);
    });
  }

  const customActions = manifest.custom_actions;
  if (customActions != null) {
    if (!Array.isArray(customActions)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_custom_actions',
        'custom_actions',
        'custom_actions must be an array when present.',
      );
    } else {
      customActions.forEach((action, index) => {
        const path = `custom_actions[${index}]`;
        if (!isRecord(action)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.invalid_custom_action',
            path,
            `${path} must be an object.`,
          );
          return;
        }
        if (!isNonEmptyString(action.name)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.invalid_custom_action_name',
            `${path}.name`,
            `${path}.name must be a non-empty string.`,
          );
        } else {
          if (OFFICIAL_ACTION_SET.has(action.name)) {
            addFinding(
              ctx,
              'error',
              'action_manifest.custom_action_overlaps_official',
              `${path}.name`,
              `${action.name} is official and must be declared in supported_official_actions.`,
            );
          }
          if (declaredActions.has(action.name)) {
            addFinding(
              ctx,
              'error',
              'action_manifest.duplicate_action',
              `${path}.name`,
              `${action.name} is declared more than once.`,
            );
          }
          declaredActions.add(action.name);
        }
        validateActionCatalogEntry(
          ctx,
          action,
          path,
          isNonEmptyString(action.name) ? action.name : undefined,
        );
      });
    }
  }

  if (manifest.action_metadata != null) {
    if (!isRecord(manifest.action_metadata)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_action_metadata',
        'action_metadata',
        'action_metadata must be an object when present.',
      );
    } else {
      for (const [action, metadata] of Object.entries(manifest.action_metadata)) {
        if (!declaredActions.has(action)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.metadata_for_undeclared_action',
            `action_metadata.${action}`,
            `Metadata action ${action} is not declared by the manifest.`,
          );
        }
        validateActionCatalogEntry(ctx, metadata, `action_metadata.${action}`, action);
      }
    }
  }

  for (const { field, nameField } of [
    { field: 'custom_assertion_operators', nameField: 'name' },
    { field: 'state_refs', nameField: 'name' },
  ]) {
    const declarations = manifest[field];
    if (declarations == null) continue;
    if (!Array.isArray(declarations)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_declaration_array',
        field,
        `${field} must be an array when present.`,
      );
      continue;
    }
    declarations.forEach((entry, index) => {
      const path = `${field}[${index}]`;
      if (!isRecord(entry) || !isNonEmptyString(entry[nameField])) {
        addFinding(
          ctx,
          'error',
          'action_manifest.invalid_declaration',
          path,
          `${path}.${nameField} must be a non-empty string.`,
        );
      }
    });
  }

  const preConditions = manifest.pre_conditions;
  if (preConditions != null) {
    if (!Array.isArray(preConditions)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_pre_conditions',
        'pre_conditions',
        'pre_conditions must be an array when present.',
      );
    } else {
      preConditions.forEach((entry, index) => {
        const path = `pre_conditions[${index}]`;
        if (!isRecord(entry)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.invalid_pre_condition',
            path,
            `${path} must be an object.`,
          );
          return;
        }
        if (!isNonEmptyString(entry.id)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.invalid_pre_condition_id',
            `${path}.id`,
            `${path}.id must be a non-empty string.`,
          );
        }
        if (!isNonEmptyString(entry.description)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.invalid_pre_condition_description',
            `${path}.description`,
            `${path}.description must be a non-empty string.`,
          );
        }
      });
    }
  }

  const nativeBindings = manifest.native_bindings;
  if (nativeBindings != null) {
    if (!Array.isArray(nativeBindings)) {
      addFinding(
        ctx,
        'error',
        'action_manifest.invalid_native_bindings',
        'native_bindings',
        'native_bindings must be an array when present.',
      );
    } else {
      nativeBindings.forEach((binding, index) => {
        const path = `native_bindings[${index}]`;
        if (!isRecord(binding)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.invalid_native_binding',
            path,
            `${path} must be an object.`,
          );
          return;
        }
        if (!isNonEmptyString(binding.action)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.invalid_native_binding_action',
            `${path}.action`,
            `${path}.action must be a non-empty string.`,
          );
        } else if (!declaredActions.has(binding.action)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.native_binding_for_undeclared_action',
            `${path}.action`,
            `Native binding action ${binding.action} is not declared by the manifest.`,
          );
        }
        if (!isNonEmptyString(binding.implementation)) {
          addFinding(
            ctx,
            'error',
            'action_manifest.invalid_native_binding_implementation',
            `${path}.implementation`,
            `${path}.implementation must be a non-empty string.`,
          );
        }
      });
    }
  }

  return finishResult(ctx);
}

export function getRecipeActionManifestPreconditionIds(manifest: unknown): string[] {
  if (!isRecord(manifest) || !Array.isArray(manifest.pre_conditions)) return [];
  return manifest.pre_conditions.flatMap((entry): string[] =>
    isRecord(entry) && isNonEmptyString(entry.id) ? [entry.id] : [],
  );
}
