'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Chromium extension IDs encode each SHA-256 nibble as a-p.
const CHROMIUM_EXTENSION_ID_ALPHABET = 'abcdefghijklmnop';

function extensionIdFromManifestKey(keyBase64) {
  if (typeof keyBase64 !== 'string' || !keyBase64) return '';
  const digest = crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest();
  return [...digest.subarray(0, 16)]
    .map(
      (byte) =>
        `${CHROMIUM_EXTENSION_ID_ALPHABET[byte >> 4]}${CHROMIUM_EXTENSION_ID_ALPHABET[byte & 0x0f]}`,
    )
    .join('');
}

function extensionIdFromManifestFile(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return extensionIdFromManifestKey(manifest.key);
  } catch {
    return '';
  }
}

function extensionIdFromExtensionDir(extensionDir) {
  return extensionIdFromManifestFile(path.join(extensionDir, 'manifest.json'));
}

module.exports = {
  CHROMIUM_EXTENSION_ID_ALPHABET,
  extensionIdFromManifestKey,
  extensionIdFromManifestFile,
  extensionIdFromExtensionDir,
};
