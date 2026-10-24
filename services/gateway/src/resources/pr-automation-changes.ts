import { resourceRevisions } from './revisions.js';

/** PR owners publish after the committed result is readable; keys carry no private owner IDs. */
export function publishPRAutomationResources(revisions = resourceRevisions): void {
  revisions.advance({ family: 'pr-automation', scope: 'farm' });
}
