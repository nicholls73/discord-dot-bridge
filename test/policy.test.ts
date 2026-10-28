import { describe, expect, it } from 'vitest';
import {
  applyAuthorizationMutation,
  emptyDiscordAuthorization,
  hasDiscordAccess,
  isDiscordAuthorization,
  validateMentionCandidate,
  type DiscordAuthorization,
  type GatewayMentionCandidate,
} from '../src/policy.js';

const GUILD = '11111111111111111';
const OTHER_GUILD = '88888888888888888';
const BOT = '22222222222222222';
const NICK = '33333333333333333';
const ROLE = '44444444444444444';

function candidate(overrides: Partial<GatewayMentionCandidate> = {}): GatewayMentionCandidate {
  return {
    guildId: GUILD,
    channelId: '55555555555555555',
    messageId: '66666666666666666',
    authorId: NICK,
    authorDisplayName: 'Synthetic user',
    authorIsBot: false,
    mentionedUserIds: [BOT],
    content: 'Can you check this?',
    timestamp: '2026-10-04T12:00:00.000Z',
    ...overrides,
  };
}

describe('runtime Discord authorization policy', () => {
  it('starts empty and denies every new server and member', () => {
    expect(emptyDiscordAuthorization()).toEqual({ guilds: {} });
    expect(hasDiscordAccess(emptyDiscordAuthorization(), GUILD, NICK, [ROLE])).toBe(false);
  });

  it('requires an approved server and grants access to an individual user or current role', () => {
    let authorization: DiscordAuthorization = emptyDiscordAuthorization();
    authorization = applyAuthorizationMutation(authorization, { action: 'approve-server', guildId: GUILD });
    authorization = applyAuthorizationMutation(authorization, { action: 'grant-user', guildId: GUILD, id: NICK });
    expect(hasDiscordAccess(authorization, GUILD, NICK, [])).toBe(true);
    expect(hasDiscordAccess(authorization, GUILD, '77777777777777777', [])).toBe(false);

    authorization = applyAuthorizationMutation(authorization, { action: 'grant-role', guildId: GUILD, id: ROLE });
    expect(hasDiscordAccess(authorization, GUILD, '77777777777777777', [ROLE])).toBe(true);
    expect(hasDiscordAccess(authorization, OTHER_GUILD, '77777777777777777', [ROLE])).toBe(false);
    expect(hasDiscordAccess(authorization, GUILD, '77777777777777777', [])).toBe(false);
  });

  it('removes access immediately when a user, role, or server grant is revoked', () => {
    let authorization = applyAuthorizationMutation(emptyDiscordAuthorization(), { action: 'approve-server', guildId: GUILD });
    authorization = applyAuthorizationMutation(authorization, { action: 'grant-user', guildId: GUILD, id: NICK });
    authorization = applyAuthorizationMutation(authorization, { action: 'grant-role', guildId: GUILD, id: ROLE });
    authorization = applyAuthorizationMutation(authorization, { action: 'revoke-user', guildId: GUILD, id: NICK });
    expect(hasDiscordAccess(authorization, GUILD, NICK, [])).toBe(false);
    expect(hasDiscordAccess(authorization, GUILD, NICK, [ROLE])).toBe(true);
    authorization = applyAuthorizationMutation(authorization, { action: 'revoke-role', guildId: GUILD, id: ROLE });
    expect(hasDiscordAccess(authorization, GUILD, NICK, [ROLE])).toBe(false);
    authorization = applyAuthorizationMutation(authorization, { action: 'revoke-server', guildId: GUILD });
    expect(hasDiscordAccess(authorization, GUILD, NICK, [ROLE])).toBe(false);
  });

  it('requires server approval before adding a user or role and bounds the stored scopes', () => {
    expect(() => applyAuthorizationMutation(emptyDiscordAuthorization(), {
      action: 'grant-role', guildId: GUILD, id: ROLE,
    })).toThrow('Approve the server');

    let authorization = applyAuthorizationMutation(emptyDiscordAuthorization(), { action: 'approve-server', guildId: GUILD });
    for (let index = 0; index < 100; index += 1) {
      authorization = applyAuthorizationMutation(authorization, {
        action: 'grant-user', guildId: GUILD, id: `1${String(index).padStart(16, '0')}`,
      });
    }
    expect(() => applyAuthorizationMutation(authorization, {
      action: 'grant-user', guildId: GUILD, id: '19999999999999999',
    })).toThrow('maximum of 100 users');
    expect(isDiscordAuthorization(authorization)).toBe(true);
  });

  it.each([
    ['other author shape', { authorId: 'not-a-snowflake' }],
    ['bot author', { authorIsBot: true }],
    ['no direct bot mention', { mentionedUserIds: [] }],
    ['invalid channel', { channelId: 'not-a-snowflake' }],
    ['oversized content', { content: 'x'.repeat(2001) }],
  ])('rejects malformed or unsafe mention data: %s', (_label, overrides) => {
    expect(validateMentionCandidate(candidate(overrides), BOT)).not.toBeNull();
  });

  it('requires the configured bot identity for mention intake', () => {
    expect(validateMentionCandidate(candidate(), undefined)).toBe('bridge_not_configured');
    expect(validateMentionCandidate(candidate(), 'invalid')).toBe('bridge_not_configured');
  });
});
