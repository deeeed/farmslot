// A recorded fingerprint ("baseline") next to the runtime state, written
// atomically and only while the inputs still produce the expected fingerprint.
// Metro env freshness and source freshness both use it.
import fs from 'node:fs';
import path from 'node:path';

export type FingerprintStatus = 'current' | 'missing' | 'changed';

export interface FingerprintCheck {
  fingerprint: string;
  status: FingerprintStatus;
}

interface FingerprintBaseline {
  schemaVersion: 1;
  fingerprint: string;
  recordedAt: string;
}

export function checkFingerprintBaseline(
  markerPath: string,
  fingerprint: string,
): FingerprintCheck {
  const baseline = readFingerprintBaseline(markerPath);
  return {
    fingerprint,
    status:
      baseline === null ? 'missing' : baseline.fingerprint === fingerprint ? 'current' : 'changed',
  };
}

// Records `expectedFingerprint` unless `fingerprint()` drifts before, during or
// right after the write; a drift leaves no baseline for that value behind.
export function recordFingerprintBaseline(
  markerPath: string,
  expectedFingerprint: string,
  fingerprint: () => string,
): boolean {
  if (fingerprint() !== expectedFingerprint) return false;
  const temporary = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  const baseline: FingerprintBaseline = {
    schemaVersion: 1,
    fingerprint: expectedFingerprint,
    recordedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
    if (fingerprint() !== expectedFingerprint) return false;
    fs.renameSync(temporary, markerPath);
    if (fingerprint() !== expectedFingerprint) {
      if (readFingerprintBaseline(markerPath)?.fingerprint === expectedFingerprint) {
        fs.rmSync(markerPath, { force: true });
      }
      return false;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}

function readFingerprintBaseline(markerPath: string): FingerprintBaseline | null {
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, 'utf8');
  } catch (error) {
    // No baseline recorded yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: Partial<FingerprintBaseline>;
  try {
    parsed = JSON.parse(raw) as Partial<FingerprintBaseline>;
  } catch (error) {
    // A torn or hand-edited baseline proves nothing; treat it as missing so the
    // next launch records a fresh one.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return parsed.schemaVersion === 1 && typeof parsed.fingerprint === 'string'
    ? (parsed as FingerprintBaseline)
    : null;
}
