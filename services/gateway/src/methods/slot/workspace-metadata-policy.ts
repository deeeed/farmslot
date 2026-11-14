const PACKED_REFS = 'packed-refs';
const REPLACEMENT_REFS = 'refs/replace';
const ALTERNATES = 'objects/info/alternates';

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
  packedRefs: string;
  replacementRefs: string;
  alternates: string;
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
  packedRefs: PACKED_REFS,
  replacementRefs: REPLACEMENT_REFS,
  alternates: ALTERNATES,
  files: [
    { directory: 'git', path: 'index' },
    { directory: 'common', path: PACKED_REFS },
    { directory: 'common', path: 'config' },
    { directory: 'common', path: 'refs/remotes/origin', appendDefaultBranch: true },
    { directory: 'git', path: 'FETCH_HEAD' },
    { directory: 'common', path: 'shallow', blocksAncestryCache: true },
    { directory: 'common', path: 'info/grafts', blocksAncestryCache: true },
    { directory: 'common', path: REPLACEMENT_REFS, blocksAncestryCache: true },
    { directory: 'common', path: ALTERNATES },
  ],
};

export interface WorkspaceMetadataVersion {
  version: string;
  ancestryCacheable: boolean;
  alternatesPath?: string;
}
