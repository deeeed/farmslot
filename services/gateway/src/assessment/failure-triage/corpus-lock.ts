// Frozen before candidate inference. Regeneration starts a new experiment.
export const CORPUS_HASH = '359d970de22283865cc4d171fac735a819e93cdb7feb42248833c1887de361d4';

export const CORPORA = {
  v1: { hash: CORPUS_HASH, file: 'corpus.json' },
  v2: {
    hash: 'f678519daa6c014922e1f89a046ec22e4985cb2d1a2155047674e781c3d13d62',
    file: 'corpus-v2.json',
  },
} as const;
export type CorpusVersion = keyof typeof CORPORA;
