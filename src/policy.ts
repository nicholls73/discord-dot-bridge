const SNOWFLAKE = /^\d{17,20}$/;
const MAX_SERVERS = 50;
const MAX_GRANTS_PER_SERVER = 100;

export interface DiscordAuthorization {
  guilds: Record<string, { userIds: string[]; roleIds: string[] }>;
}

export type AuthorizationMutation =
  | { action: 'approve-server' | 'revoke-server'; guildId: string }
  | { action: 'grant-user' | 'revoke-user'; guildId: string; id: string }
  | { action: 'grant-role' | 'revoke-role'; guildId: string; id: string };

export interface GatewayMentionCandidate {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorDisplayName: string;
  authorIsBot: boolean;
  mentionedUserIds: string[];
  content: string;
  timestamp: string;
}

export interface OriginMessage extends GatewayMentionCandidate {
  eventId: string;
  messageUrl: string;
}

export function emptyDiscordAuthorization(): DiscordAuthorization {
  return { guilds: {} };
}

export function isDiscordAuthorization(value: unknown): value is DiscordAuthorization {
  if (!isRecord(value) || !isRecord(value.guilds)) return false;
  const guilds = Object.entries(value.guilds);
  if (guilds.length > MAX_SERVERS) return false;
  return guilds.every(([guildId, grant]) => isDiscordSnowflake(guildId) && isRecord(grant) &&
    Array.isArray(grant.userIds) && Array.isArray(grant.roleIds) &&
    grant.userIds.length <= MAX_GRANTS_PER_SERVER && grant.roleIds.length <= MAX_GRANTS_PER_SERVER &&
    isUniqueSnowflakeList(grant.userIds) && isUniqueSnowflakeList(grant.roleIds));
}

export function applyAuthorizationMutation(
  authorization: DiscordAuthorization,
  mutation: AuthorizationMutation,
): DiscordAuthorization {
  if (!['approve-server', 'revoke-server', 'grant-user', 'revoke-user', 'grant-role', 'revoke-role'].includes(mutation.action)) {
    throw new TypeError('Choose a supported access change.');
  }
  if (!isDiscordSnowflake(mutation.guildId)) throw new TypeError('Enter a valid server ID.');
  const guilds = Object.fromEntries(Object.entries(authorization.guilds).map(([id, grants]) => [id, {
    userIds: [...grants.userIds],
    roleIds: [...grants.roleIds],
  }])) as DiscordAuthorization['guilds'];

  if (mutation.action === 'approve-server') {
    if (!guilds[mutation.guildId] && Object.keys(guilds).length >= MAX_SERVERS) {
      throw new TypeError(`A maximum of ${MAX_SERVERS} servers can be approved.`);
    }
    guilds[mutation.guildId] ??= { userIds: [], roleIds: [] };
  } else if (mutation.action === 'revoke-server') {
    delete guilds[mutation.guildId];
  } else {
    if (!('id' in mutation)) throw new TypeError('Choose a supported access change.');
    if (!isDiscordSnowflake(mutation.id)) throw new TypeError('Enter a valid Discord user or role ID.');
    const grants = guilds[mutation.guildId];
    if (!grants) throw new TypeError('Approve the server before granting access.');
    const key = mutation.action.endsWith('user') ? 'userIds' : 'roleIds';
    const id = mutation.id;
    const list = grants[key];
    const revoke = mutation.action.startsWith('revoke-');
    if (revoke) {
      grants[key] = list.filter((grantedId) => grantedId !== id);
    } else if (!list.includes(id)) {
      if (list.length >= MAX_GRANTS_PER_SERVER) {
        throw new TypeError(`A maximum of ${MAX_GRANTS_PER_SERVER} ${key === 'userIds' ? 'users' : 'roles'} can be granted per server.`);
      }
      grants[key] = [...list, id];
    }
  }

  return { guilds };
}

/** A direct user grant or any currently held, same-server role grant is sufficient. */
export function hasDiscordAccess(
  authorization: DiscordAuthorization,
  guildId: string,
  userId: string,
  currentRoleIds: readonly string[],
): boolean {
  const grants = authorization.guilds[guildId];
  return Boolean(grants && (
    grants.userIds.includes(userId) || currentRoleIds.some((roleId) => grants.roleIds.includes(roleId))
  ));
}

export function validateMentionCandidate(
  candidate: GatewayMentionCandidate,
  botUserId: string | undefined,
): string | null {
  if (!candidate || typeof candidate !== 'object') return 'invalid_event';
  if (!isDiscordSnowflake(candidate.guildId) || !isDiscordSnowflake(candidate.authorId) || candidate.authorIsBot !== false) {
    return 'author_not_allowed';
  }
  if (!isDiscordSnowflake(candidate.channelId) || !isDiscordSnowflake(candidate.messageId)) return 'invalid_message_reference';
  if (!botUserId || !isDiscordSnowflake(botUserId)) return 'bridge_not_configured';
  if (!Array.isArray(candidate.mentionedUserIds) || !candidate.mentionedUserIds.includes(botUserId)) return 'bot_not_mentioned';
  if (typeof candidate.content !== 'string' || candidate.content.length > 2000) return 'invalid_content';
  if (typeof candidate.authorDisplayName !== 'string' || candidate.authorDisplayName.length > 128) return 'invalid_author_name';
  if (!Number.isFinite(Date.parse(candidate.timestamp))) return 'invalid_timestamp';
  return null;
}

export function isAllowedOrigin(origin: OriginMessage, botUserId: string | undefined): boolean {
  return origin.eventId === origin.messageId && validateMentionCandidate(origin, botUserId) === null;
}

export function toOriginMessage(candidate: GatewayMentionCandidate): OriginMessage {
  return {
    ...candidate,
    eventId: candidate.messageId,
    timestamp: new Date(candidate.timestamp).toISOString(),
    messageUrl: `https://discord.com/channels/${candidate.guildId}/${candidate.channelId}/${candidate.messageId}`,
  };
}

export function isDiscordSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

function isUniqueSnowflakeList(value: unknown[]): value is string[] {
  return value.every((id) => typeof id === 'string' && isDiscordSnowflake(id)) && new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
