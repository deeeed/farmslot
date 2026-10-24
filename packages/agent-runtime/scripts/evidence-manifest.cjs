const MANIFEST_KEYS = new Set([
  'version',
  'preferred_mode',
  'summary',
  'before_after_pairs',
  'standalone',
  'omit',
  'videos',
  'before_state_capture',
]);
const PAIR_KEYS = new Set(['label', 'covers', 'before', 'after', 'note']);
const STANDALONE_KEYS = new Set(['label', 'covers', 'file', 'note']);
const VIDEO_KEYS = new Set(['before', 'after', 'preferred', 'note']);
const OMIT_KEYS = new Set(['file', 'reason']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushUnknownKeyIssues(issues, path, record, allowed) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push(`${path}.${key}: unknown key`);
  }
}

function optionalString(issues, record, path, key) {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    issues.push(`${path}.${key}: expected string`);
  }
}

function optionalStringArray(issues, record, path, key) {
  const value = record[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    issues.push(`${path}.${key}: expected string[]`);
  }
}

function validateEvidenceManifest(value) {
  const issues = [];
  if (!isRecord(value)) return ['manifest: expected object'];
  pushUnknownKeyIssues(issues, 'manifest', value, MANIFEST_KEYS);

  if (value.version !== undefined && typeof value.version !== 'number') {
    issues.push('manifest.version: expected number');
  }
  if (
    value.preferred_mode !== undefined &&
    value.preferred_mode !== 'screenshots' &&
    value.preferred_mode !== 'video'
  ) {
    issues.push('manifest.preferred_mode: expected "screenshots" or "video"');
  }
  optionalString(issues, value, 'manifest', 'summary');
  if (value.omit !== undefined) {
    if (!Array.isArray(value.omit)) {
      issues.push('manifest.omit: expected array');
    } else {
      value.omit.forEach((entry, index) => {
        const path = `manifest.omit[${index}]`;
        if (typeof entry === 'string') return;
        if (!isRecord(entry)) {
          issues.push(`${path}: expected string or object`);
          return;
        }
        pushUnknownKeyIssues(issues, path, entry, OMIT_KEYS);
        if (typeof entry.file !== 'string' || !entry.file.trim()) {
          issues.push(`${path}.file: expected non-empty string`);
        }
        optionalString(issues, entry, path, 'reason');
      });
    }
  }
  if (value.before_state_capture !== undefined && !isRecord(value.before_state_capture)) {
    issues.push('manifest.before_state_capture: expected object');
  }

  if (value.before_after_pairs !== undefined) {
    if (!Array.isArray(value.before_after_pairs)) {
      issues.push('manifest.before_after_pairs: expected array');
    } else {
      value.before_after_pairs.forEach((entry, index) => {
        const path = `manifest.before_after_pairs[${index}]`;
        if (!isRecord(entry)) {
          issues.push(`${path}: expected object`);
          return;
        }
        pushUnknownKeyIssues(issues, path, entry, PAIR_KEYS);
        if (typeof entry.label !== 'string' || !entry.label.trim()) {
          issues.push(`${path}.label: expected non-empty string`);
        }
        optionalStringArray(issues, entry, path, 'covers');
        optionalString(issues, entry, path, 'before');
        optionalString(issues, entry, path, 'after');
        optionalString(issues, entry, path, 'note');
        if (entry.before === undefined && entry.after === undefined) {
          issues.push(`${path}: expected before or after`);
        }
      });
    }
  }

  if (value.standalone !== undefined) {
    if (!Array.isArray(value.standalone)) {
      issues.push('manifest.standalone: expected array');
    } else {
      value.standalone.forEach((entry, index) => {
        const path = `manifest.standalone[${index}]`;
        if (!isRecord(entry)) {
          issues.push(`${path}: expected object`);
          return;
        }
        pushUnknownKeyIssues(issues, path, entry, STANDALONE_KEYS);
        if (typeof entry.label !== 'string' || !entry.label.trim()) {
          issues.push(`${path}.label: expected non-empty string`);
        }
        optionalStringArray(issues, entry, path, 'covers');
        if (typeof entry.file !== 'string' || !entry.file.trim()) {
          issues.push(`${path}.file: expected non-empty string`);
        }
        optionalString(issues, entry, path, 'note');
      });
    }
  }

  if (value.videos !== undefined) {
    if (!isRecord(value.videos)) {
      issues.push('manifest.videos: expected object');
    } else {
      pushUnknownKeyIssues(issues, 'manifest.videos', value.videos, VIDEO_KEYS);
      optionalString(issues, value.videos, 'manifest.videos', 'before');
      optionalString(issues, value.videos, 'manifest.videos', 'after');
      optionalString(issues, value.videos, 'manifest.videos', 'note');
      if (value.videos.preferred !== undefined && typeof value.videos.preferred !== 'boolean') {
        issues.push('manifest.videos.preferred: expected boolean');
      }
    }
  }

  return issues;
}

module.exports = { validateEvidenceManifest };
