import { readFileSync } from 'node:fs';

import { CORPUS_HASH } from './corpus-lock.js';
import { textDigest } from './packet.js';
import { LABELS, type TriageCorpus } from './types.js';

export function loadTriageCorpus(): TriageCorpus {
  const bytes = readFileSync(
    new URL('../../../../../scripts/failure-triage/corpus.json', import.meta.url),
    'utf8',
  );
  if (textDigest(bytes) !== CORPUS_HASH)
    throw new Error('Bundled corpus changed; freeze a new experiment before evaluation');
  // Exact-byte admission binds this parse to the generated, reviewed schema.
  const corpus = JSON.parse(bytes) as TriageCorpus;
  if (corpus.version !== 1 || corpus.cases.length !== 30) throw new Error('Invalid frozen corpus');
  const groups = new Set<string>(),
    ids = new Set<string>();
  for (const c of corpus.cases) {
    if (
      ids.has(c.id) ||
      groups.has(c.group) ||
      c.origin.kind !== 'synthetic' ||
      c.origin.generator !== corpus.generatorVersion ||
      c.packet.caseId !== c.id ||
      c.packet.failure.status !== 'failed'
    )
      throw new Error('Invalid corpus identity, split or provenance');
    ids.add(c.id);
    groups.add(c.group);
    for (const e of c.packet.evidence)
      if (textDigest(e.text) !== e.digest) throw new Error('Invalid corpus evidence digest');
  }
  for (const label of LABELS) {
    const cases = corpus.cases.filter((c) => c.reference.label === label);
    if (
      cases.length !== (label === 'unclear' ? 6 : 4) ||
      cases.filter((c) => c.split === 'held-out').length !== 3
    )
      throw new Error('Invalid corpus stratification');
  }
  return corpus;
}
