'use strict';

/** Insert external text without interpreting JavaScript replacement patterns. */
function literalReplacement(value) {
  return () => value;
}

module.exports = { literalReplacement };
