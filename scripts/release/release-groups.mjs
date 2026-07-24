/** @typedef {{ id: string; label: string; workspaces: string[] }} ReleaseGroup */

/** @type {ReleaseGroup[]} */
export const RELEASE_GROUPS = [
  {
    id: 'hosted-cc',
    label: 'Hosted Command Center',
    workspaces: [
      'apps/command-center/ui',
      'apps/command-center',
      'services/gateway',
      'packages/protocol',
    ],
  },
  {
    id: 'companion',
    label: 'Mobile Companion',
    workspaces: ['apps/companion'],
  },
  {
    id: 'npm',
    label: 'Published npm packages',
    workspaces: [
      'packages/protocol',
      'packages/agent-runtime',
      'packages/recipe-harness',
      'packages/expo-recipe',
      'packages/skills',
    ],
  },
];

export function resolveReleaseGroup(groupId) {
  const group = RELEASE_GROUPS.find((entry) => entry.id === groupId);
  if (!group) {
    const ids = RELEASE_GROUPS.map((entry) => entry.id).join(', ');
    throw new Error(`Unknown release group '${groupId}'. Expected one of: ${ids}`);
  }
  return group;
}
