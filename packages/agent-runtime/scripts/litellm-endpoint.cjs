// Shared LiteLLM endpoint identity for Pi request entries and gateway prices.
// The identity is a digest: no part of the URL, including credentials embedded in its user info,
// host, path, query or fragment, is ever persisted.
const { createHash } = require('node:crypto');

/**
 * The digest of a LiteLLM base URL, canonicalized as the pricing loader queries it: user info,
 * query and fragment dropped, trailing slashes and one trailing `/v1` removed. Undefined when the
 * value is not a URL, which names no endpoint anyone could verify.
 */
function liteLlmEndpointId(baseUrl) {
  if (typeof baseUrl !== 'string' || !URL.canParse(baseUrl)) return undefined;
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return (
    'sha256:' +
    createHash('sha256')
      .update(`farmslot-litellm-endpoint-v1\n${url.protocol}//${url.host}${pathname}`)
      .digest('hex')
  );
}

module.exports = { liteLlmEndpointId };
