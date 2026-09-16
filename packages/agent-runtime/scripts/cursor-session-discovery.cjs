// Read-only recovery for older terminal launches that did not persist their chat ID.
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(process.argv.at(-1));
const root = input.root.replace(/^~(?=\/|$)/, process.env.HOME);
const matches = [];
if (
  !path.isAbsolute(input.cwd) ||
  !Number.isFinite(input.startedAt) ||
  !Number.isFinite(input.completedAt) ||
  input.completedAt < input.startedAt
)
  throw Error('Invalid session discovery bounds');
function directories(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
for (const workspace of directories(root))
  for (const chat of directories(workspace)) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(path.basename(chat))) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
    } catch (error) {
      // Concurrently created or truncated metadata is not evidence of a recoverable chat.
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (
      meta.schemaVersion === 1 &&
      meta.hasConversation === true &&
      meta.cwd === input.cwd &&
      Number.isFinite(meta.createdAtMs) &&
      meta.createdAtMs >= input.startedAt &&
      meta.createdAtMs <= input.completedAt
    )
      matches.push({ sessionId: path.basename(chat) });
  }
if (matches.length > 1)
  throw Error('Several chats match the review workspace; session recovery is ambiguous');
process.stdout.write(JSON.stringify(matches[0] ?? null));
