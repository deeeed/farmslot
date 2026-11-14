'use strict';

/** Adapter-owned recognition of the provider's structured maintenance boundary. */
function claudeCompactionBoundary(message, nativeSessionId) {
  const metadata = message?.compact_metadata;
  if (
    message?.type !== 'system' ||
    message.subtype !== 'compact_boundary' ||
    message.session_id !== nativeSessionId ||
    metadata?.trigger !== 'manual' ||
    typeof message.uuid !== 'string' ||
    !message.uuid
  )
    return undefined;
  const counts = Object.fromEntries(
    Object.entries({
      preTokens: metadata.pre_tokens,
      postTokens: metadata.post_tokens,
      durationMs: metadata.duration_ms,
    }).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0),
  );
  return {
    nativeSessionId,
    boundaryId: message.uuid,
    completedAt: new Date().toISOString(),
    ...counts,
  };
}

function claudeCompactionArgs(sessionId, model) {
  return [
    '--print',
    '--resume',
    sessionId,
    '--model',
    model,
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    '',
    '--settings',
    '{"disableAllHooks":true}',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    '',
  ];
}

module.exports = { claudeCompactionBoundary, claudeCompactionArgs };
