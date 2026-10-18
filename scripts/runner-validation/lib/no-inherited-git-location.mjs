// Proofs build fixture repositories and start disposable gateways. A git
// location inherited from a hook or `rebase --exec` (GIT_DIR, GIT_INDEX_FILE
// and the rest) would point that git, and every child that inherits it,
// including a gateway's slot git, at the operator's repository. Imported first,
// so the proof's own environment never carries one.
import { GIT_LOCATION_ENV } from '../../quality/run-tsx-tests.mjs';

for (const key of GIT_LOCATION_ENV) delete process.env[key];
