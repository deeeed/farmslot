import path from 'node:path';

import type { ExecutionTemplateEntry } from '@farmslot/agent-runtime';
import {
  type RecipeConformanceReport,
  recipeFlowRequirements,
  type RecipeProjectCompatibility,
  recipeProjectCompatibility,
  type RuntimeCapabilityCatalogEntry,
  validateProjectRecipeConfig,
} from '@farmslot/protocol';

import { getProjectFieldRaw, type ProjectVars, type SlotVars } from '../core/config.js';
import { resolvePathWithinRemoteBase } from '../core/remote-paths.js';
import { NodeExecUnconfirmedError } from '../fleet/node-rpc.js';
import type { HostedRecipeConformanceOptions } from '../methods/recipe.js';

interface RecipeDispatchCheckDependencies {
  report(options: HostedRecipeConformanceOptions): Promise<RecipeConformanceReport>;
  exists(file: string): Promise<boolean>;
  resources(): Promise<RuntimeCapabilityCatalogEntry[]>;
}

/** Preflight the selected flow without acquiring resources or running its smoke. */
export async function checkRecipeDispatchRequirements(
  project: ProjectVars,
  slot: SlotVars,
  selected: Pick<ExecutionTemplateEntry, 'frontmatter' | 'sha256'> | undefined,
  selection: { app?: string; domain?: string } = {},
  dependencies?: RecipeDispatchCheckDependencies,
): Promise<RecipeProjectCompatibility> {
  const required = recipeFlowRequirements(selected?.frontmatter ?? null);
  const declaration = getProjectFieldRaw(project.projectJson, 'recipe');
  if (declaration !== undefined) validateProjectRecipeConfig(declaration);
  const registered = declaration !== undefined;
  const deps: RecipeDispatchCheckDependencies = dependencies ?? {
    async report(options) {
      const { recipeProjectHookRun } = await import('../methods/recipe.js');
      const result = await recipeProjectHookRun(
        {
          project: project.projectName,
          slotId: slot.slotId,
          hook: 'recipe_doctor',
        },
        options,
      );
      if (!result.conformance) throw new Error('Hosted doctor returned no conformance report.');
      return result.conformance;
    },
    async exists(file) {
      const { slotFileExists } = await import('../core/slot-io.js');
      return slotFileExists(slot, file);
    },
    async resources() {
      const { runtimeCapabilityList } = await import('../methods/runtime-capabilities.js');
      return (await runtimeCapabilityList({ slotId: slot.slotId })).capabilities;
    },
  };
  const diagnostics: string[] = [];
  let report: RecipeConformanceReport | undefined;
  if (registered && required.recipes.length) {
    const relative = path.posix.join(project.artifactDir, 'conformance', 'conformance-report.json');
    const file = resolvePathWithinRemoteBase(slot.remoteRepo, relative);
    if (!file) throw new Error('Project artifact directory must be inside the selected checkout.');
    const options = { recipes: required.recipes, params: required.params, ...selection };
    if (await deps.exists(file)) {
      try {
        report = await deps.report({ ...options, checkReport: relative });
      } catch (error) {
        if (error instanceof NodeExecUnconfirmedError) throw error;
        // A stale/failed retained check is not live evidence. Current preflight can still
        // admit the selected flow, while the display retains the verification refusal.
        diagnostics.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!report) {
      try {
        report = await deps.report({ ...options, reportName: `dispatch-${selected!.sha256}.json` });
      } catch (error) {
        if (error instanceof NodeExecUnconfirmedError) throw error;
        // Failed preflight becomes explicit missing requirements and blocks dispatch below.
        diagnostics.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  const scope = report?.identity ?? {
    project: project.projectName,
    app: selection.app ?? declaration?.app ?? null,
    domain: selection.domain ?? declaration?.domain ?? null,
    adapter: declaration?.adapter ?? slot.platform,
    target: slot.remoteRepo,
  };
  const result = recipeProjectCompatibility({
    scope: {
      project: project.projectName,
      app: selection.app ?? scope.app,
      domain: selection.domain ?? scope.domain,
      adapter: scope.adapter,
      target: scope.target,
    },
    registered,
    required,
    report,
    resources: required.resources.length ? await deps.resources() : [],
  });
  return { ...result, ...(diagnostics.length ? { diagnostics } : {}) };
}

export function assertRecipeDispatchRequirements(result: RecipeProjectCompatibility): void {
  if (result.missingRequirements.length)
    throw new Error(
      `Selected flow is missing ${result.missingRequirements.join(', ')}.${result.diagnostics?.length ? ` ${result.diagnostics.join('; ')}` : ''} Run farmslot doctor --conformance for this target and selected smoke.`,
    );
}
