interface WorkspaceMetadataFile {
  directory: 'git' | 'common';
  path: string;
  appendDefaultBranch?: boolean;
  blocksAncestryCache?: boolean;
}
interface WorkspaceMetadataPolicy {
  marker: string;
  head: string;
  commonDirectory: string;
  gitPointerPrefix: string;
  symbolicHeadPrefix: string;
  refRootPrefix: string;
  reftableHead: string;
  files: readonly WorkspaceMetadataFile[];
}

/** One metadata/layout policy, consumed by local fs and the remote Python interpreter. */
export const WORKSPACE_METADATA_POLICY: WorkspaceMetadataPolicy = {
  marker: '.git',
  head: 'HEAD',
  commonDirectory: 'commondir',
  gitPointerPrefix: 'gitdir: ',
  symbolicHeadPrefix: 'ref: ',
  refRootPrefix: 'refs/',
  reftableHead: 'ref: refs/heads/.invalid',
  files: [
    { directory: 'git', path: 'index' },
    { directory: 'common', path: 'packed-refs' },
    { directory: 'common', path: 'config' },
    { directory: 'common', path: 'refs/remotes/origin', appendDefaultBranch: true },
    { directory: 'git', path: 'FETCH_HEAD' },
    { directory: 'common', path: 'shallow', blocksAncestryCache: true },
    { directory: 'common', path: 'info/grafts', blocksAncestryCache: true },
    { directory: 'common', path: 'refs/replace', blocksAncestryCache: true },
  ],
};

export interface WorkspaceMetadataVersion {
  version: string;
  ancestryCacheable: boolean;
}
