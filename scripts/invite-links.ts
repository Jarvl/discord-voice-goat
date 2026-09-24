import { parseTokens } from '../src/config.js';
import { toError } from '../src/errors.js';
import { applicationIdFromToken, inviteUrl } from '../src/invite.js';

const tokens = parseTokens(process.env.BOT_TOKENS);
if (tokens.length === 0) {
  console.error('BOT_TOKENS is empty. Put your bot tokens in .env first (see .env.example).');
  process.exit(1);
}

console.log('Open each link and add the bot to every server in GUILD_IDS:\n');
tokens.forEach((token, i) => {
  const label = i === 0 ? `bot${i + 1} (leader)` : `bot${i + 1}`;
  try {
    console.log(`${label}: ${inviteUrl(applicationIdFromToken(token), i === 0)}`);
  } catch (err) {
    console.log(`${label}: could not read an application ID from this token (${toError(err).message})`);
    process.exitCode = 1;
  }
});
