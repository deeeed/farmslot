// Files a release cut writes, which the changelog guard does not count as
// workspace code: a PR that changes only these needs no new Unreleased bullet.
// The gateway API reference is here because its only cut-time change is the
// protocol version line, regenerated with PROTOCOL_VERSION.
export const GATEWAY_API_DOC = 'apps/docs/docs/reference/gateway-api.generated.md';

export function isReleaseOnlyFile(file) {
  return (
    file.startsWith('.release-cut/') ||
    file.endsWith('/release-notes.json') ||
    file.endsWith('/CHANGELOG.md') ||
    file.endsWith('/package.json') ||
    file === 'packages/protocol/src/version.ts' ||
    file === GATEWAY_API_DOC ||
    file.startsWith('scripts/release/') ||
    file.startsWith('.agents/skills/fs-release-cut/') ||
    file === 'docs/operations/release-process.md'
  );
}
