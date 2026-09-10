import {
  assertPRImportedProjectView,
  assertPRSourceAccount,
  compilePRProjectFilter,
  parsePRProjectURL,
  type PRProjectCatalog,
  type PRProjectImportParams,
  type PRProjectImportResult,
} from '@farmslot/protocol';

import {
  collectGitHubPages,
  githubGraphQL,
  type GitHubPage,
} from '../integrations/github-graphql.js';
import { resolvePRSourceAccount } from '../pr-monitoring/github-account.js';

import { GITHUB_PROJECT_FIELD, GITHUB_RULE_PAGE_INFO } from './github-source-types.js';

export async function importPRProject(
  ownerId: string,
  params: PRProjectImportParams,
): Promise<PRProjectImportResult> {
  assertPRSourceAccount(params.account);
  if (typeof params.url !== 'string' || params.url.length > 2048)
    throw new Error('A Project/view URL is required');
  const target = parsePRProjectURL(params.url, params.account.host);
  const account = await resolvePRSourceAccount(params.account, ownerId);
  type Project = Omit<PRProjectCatalog, 'fields'> & {
    view?: { number: number; name: string; filter: string | null } | null;
  };
  const data = await githubGraphQL<
    Partial<Record<'organization' | 'user', { projectV2: Project | null }>>
  >(
    `query($owner:String!,$number:Int!${target.viewNumber ? ',$viewNumber:Int!' : ''}) {
      ${target.ownerKind}(login:$owner) { projectV2(number:$number) { id title url
        ${target.viewNumber ? 'view(number:$viewNumber) { number name filter }' : ''}
      } }
    }`,
    {
      owner: target.owner,
      number: target.number,
      ...(target.viewNumber ? { viewNumber: target.viewNumber } : {}),
    },
    account,
  );
  const project = data[target.ownerKind]?.projectV2;
  if (!project?.id || !project.title)
    throw new Error('Project is unavailable to the selected GitHub account');
  parsePRProjectURL(project.url, params.account.host);
  if (target.viewNumber && !project.view)
    throw new Error(
      'Saved view is unavailable; importing the entire Project would broaden its scope',
    );
  const fields = await collectGitHubPages(async (cursor) => {
    const result = await githubGraphQL<{
      node: { fields: GitHubPage<PRProjectCatalog['fields'][number]> };
    }>(
      `query($id:ID!,$cursor:String) { node(id:$id) { ... on ProjectV2 { fields(first:100,after:$cursor) { ${GITHUB_RULE_PAGE_INFO} nodes { ${GITHUB_PROJECT_FIELD} } } } } }`,
      { id: project.id, cursor },
      account,
    );
    return result.node?.fields;
  });
  const source: PRProjectImportResult['source'] = {
    kind: 'github-project',
    projectId: project.id,
    label: project.title,
    url: project.url,
  };
  if (project.view) {
    const filter = project.view.filter ?? '';
    source.importedView = {
      number: project.view.number,
      name: project.view.name,
      filter,
      terms: compilePRProjectFilter(filter, project.id, fields),
    };
    assertPRImportedProjectView(source.importedView);
  }
  return { source, project: { id: project.id, title: project.title, url: project.url, fields } };
}
