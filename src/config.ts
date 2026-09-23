export interface Config {
  /** Bot tokens; index 0 is the leader. */
  botTokens: string[];
  guildId: string;
  triggerUserIds: Set<string>;
  staggerMinMs: number;
  staggerMaxMs: number;
  cooldownMs: number;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const SNOWFLAKE = /^\d{17,20}$/;

function stripQuotes(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function splitList(raw: string | undefined): string[] {
  return stripQuotes((raw ?? '').trim())
    .split(',')
    .map((part) => stripQuotes(part.trim()).trim())
    .filter((part) => part.length > 0);
}

/** Trim, drop empties, strip quotes and a leading "Bot " prefix, and dedupe. */
export function parseTokens(raw: string | undefined): string[] {
  const tokens = splitList(raw)
    .map((token) => token.replace(/^Bot\s+/i, ''))
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

/** Returns NaN (and records a problem) when the value is present but not a whole number. */
function parseMs(env: Record<string, string | undefined>, name: string, fallback: number, problems: string[]): number {
  const raw = stripQuotes(env[name]?.trim() ?? '');
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    problems.push(`${name} must be a whole number of milliseconds, got "${raw}"`);
    return Number.NaN;
  }
  return Number(raw);
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];

  const botTokens = parseTokens(env.BOT_TOKENS);
  if (botTokens.length === 0) {
    problems.push('BOT_TOKENS is required (comma-separated bot tokens; the first is the leader)');
  }

  const guildId = stripQuotes(env.GUILD_ID?.trim() ?? '');
  if (guildId === '') problems.push('GUILD_ID is required');
  else if (!SNOWFLAKE.test(guildId)) problems.push(`GUILD_ID must be a Discord ID (17-20 digits), got "${guildId}"`);

  // Optional: blank means joining voice never triggers a swarm (slash commands only).
  const triggerUserIds = splitList(env.TRIGGER_USER_IDS);
  for (const id of triggerUserIds) {
    if (!SNOWFLAKE.test(id)) problems.push(`TRIGGER_USER_IDS contains "${id}", which is not a Discord ID (17-20 digits)`);
  }

  const staggerMinMs = parseMs(env, 'STAGGER_MIN_MS', 1000, problems);
  const staggerMaxMs = parseMs(env, 'STAGGER_MAX_MS', 2000, problems);
  const cooldownMs = parseMs(env, 'COOLDOWN_MS', 30_000, problems);
  // NaN comparisons are false, so a malformed value never adds this second, confusing problem.
  if (staggerMinMs > staggerMaxMs) {
    problems.push(`STAGGER_MIN_MS (${staggerMinMs}) must not be greater than STAGGER_MAX_MS (${staggerMaxMs})`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { botTokens, guildId, triggerUserIds: new Set(triggerUserIds), staggerMinMs, staggerMaxMs, cooldownMs };
}
