import { resourceRevisions } from './revisions.js';

/** Configuration owners publish only after the new sanitized read is available. */
export function publishConfigurationResources(
  project?: string,
  revisions = resourceRevisions,
): void {
  revisions.advance({ family: 'configuration', scope: 'farm' });
  // Farm invalidation covers legacy selectors too; never publish a filesystem-shaped ID.
  if (project && !/[/\\]/.test(project) && project !== '.' && project !== '..')
    revisions.advance({ family: 'configuration', scope: 'farm', project });
}
