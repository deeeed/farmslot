import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  EXECUTION_TEMPLATE_CATALOG_DIR,
  EXECUTION_TEMPLATE_CATALOG_FILE,
  type ExecutionTemplateCatalogSnapshot,
  listExecutionTemplates,
} from '@farmslot/agent-runtime';

import type { ProjectVars } from '../core/config.js';
import { configuredExecutionTemplateSources } from '../tasks/execution-template-catalog.js';

import type { NodeSupportBundleInputs } from './ensure.js';
import { collectSupportFiles, type NodeSupportFile } from './files.js';

function dataFile(relativePath: string, data: Buffer): NodeSupportFile {
  return {
    relativePath,
    contentBase64: data.toString('base64'),
    sha256: createHash('sha256').update(data).digest('hex'),
    mode: 0o644,
    size: data.length,
  };
}

/** Only configured catalogs cross the normal farm-root boundary, never arbitrary support paths. */
export async function collectExternalTemplateCatalog(
  project: ProjectVars,
  inputs: NodeSupportBundleInputs,
): Promise<NodeSupportFile[]> {
  const declarations = (project.projectJson.execution_templates?.sources ?? []).filter(
    (source) => typeof source.root.env === 'string',
  );
  if (!declarations.length) return [];
  const pack = path.dirname(project.projectConfig);
  for (const reserved of [EXECUTION_TEMPLATE_CATALOG_DIR, EXECUTION_TEMPLATE_CATALOG_FILE]) {
    if (existsSync(path.join(pack, reserved)))
      throw new Error(
        `Reserved execution-template catalog path is already pack-owned: ${reserved}`,
      );
  }
  inputs.followed.push(project.projectConfig);
  inputs.environment ??= {};
  for (const declaration of declarations) {
    const variable = declaration.root.env;
    if (!variable) continue;
    const value = process.env[variable];
    if (!Object.hasOwn(inputs.environment, variable)) inputs.environment[variable] = value;
    if (value && path.isAbsolute(value)) {
      // Follow the declared path too: retargeting its symlink changes the binding.
      for (const input of [value, path.join(value, declaration.subpath ?? '.')]) {
        if (existsSync(input)) inputs.followed.push(input);
        else inputs.optional.push(input, path.dirname(input));
      }
    }
  }
  const configured = await configuredExecutionTemplateSources(project);
  const snapshot: ExecutionTemplateCatalogSnapshot = { version: 1, sources: [] };
  const files: NodeSupportFile[] = [];
  const projectPrefix = path.posix.join('projects', project.projectName);
  for (const declaration of declarations) {
    const source = configured.sources.find((candidate) => candidate.id === declaration.id);
    if (!source) {
      snapshot.sources.push({
        declaration,
        unavailableReason:
          configured.unavailable.find((candidate) => candidate.id === declaration.id)?.reason ??
          'missing-root',
      });
      continue;
    }
    const key = createHash('sha256').update(source.id).digest('hex');
    const relativeRoot = path.posix.join(EXECUTION_TEMPLATE_CATALOG_DIR, key);
    // A real empty catalog still needs its directory materialized on the node.
    files.push(
      dataFile(path.posix.join(projectPrefix, relativeRoot, '.catalog-root'), Buffer.alloc(0)),
    );
    inputs.followed.push(source.root);
    if (source.layout === 'flow-tree') {
      for (const entry of await readdir(source.root, { withFileTypes: true }))
        if (entry.isDirectory()) inputs.followed.push(path.join(source.root, entry.name));
    }
    for (const entry of listExecutionTemplates({ sources: [source], includeShadowed: true })) {
      const copied = await collectSupportFiles(
        entry.path,
        path.posix.join(projectPrefix, relativeRoot, entry.relativePath),
      );
      if (copied.length !== 1 || copied[0].sha256 !== entry.sha256)
        throw new Error(`Execution template changed while collecting node support: ${entry.id}`);
      files.push(...copied);
      inputs.followed.push(entry.path);
    }
    snapshot.sources.push({
      declaration,
      relativeRoot,
      ...(source.sourceRevision === undefined ? {} : { sourceRevision: source.sourceRevision }),
      ...(source.sourceDirty === undefined ? {} : { sourceDirty: source.sourceDirty }),
    });
  }
  files.push(
    dataFile(
      path.posix.join(projectPrefix, EXECUTION_TEMPLATE_CATALOG_FILE),
      Buffer.from(JSON.stringify(snapshot, null, 2) + '\n'),
    ),
  );
  return files;
}
