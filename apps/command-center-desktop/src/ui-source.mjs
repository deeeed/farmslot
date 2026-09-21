export function validateDevelopmentUrl(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('Enter a local Command Center dev server URL.');
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/', '/cc/'].includes(url.pathname)
  )
    throw new Error(
      'Use http://localhost:<port>/ or another loopback address, without credentials or query parameters.',
    );
  return url.href;
}

export function uiUrl(origin, developmentUrl) {
  return developmentUrl ?? `${origin}/cc/`;
}

export function validateDevelopmentSource(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Development UI settings.');
  const enabled = value.enabled ?? false;
  if (typeof enabled !== 'boolean') throw new Error('Development UI must be enabled or disabled.');
  const url = validateDevelopmentUrl(value.url ?? 'http://localhost:5174/');
  if (!url) throw new Error('Enter the local development server URL.');
  return { enabled, url };
}
