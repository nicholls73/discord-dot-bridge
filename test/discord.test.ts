import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordRestMessenger } from '../src/discord.js';
import type { OriginMessage } from '../src/policy.js';
const origin: OriginMessage = {
  eventId: '66666666666666666',
  guildId: '11111111111111111',
  channelId: '55555555555555555',
  messageId: '66666666666666666',
  authorId: '33333333333333333',
  authorDisplayName: 'Synthetic user',
  authorIsBot: false,
  mentionedUserIds: ['22222222222222222'],
  content: 'Original request',
  timestamp: '2026-10-04T12:00:00.000Z',
  messageUrl: 'https://discord.com/channels/11111111111111111/55555555555555555/66666666666666666',
};

const fakeResponse = (id: string, status = 200) => new Response(JSON.stringify({ id }), {
  status,
  headers: { 'content-type': 'application/json' },
});

const guildId = origin.guildId;
const channelId = origin.channelId;
const threadId = '88888888888888888';
const botUserId = '22222222222222222';
const botMessageId = '77777777777777777';
const requiredPermissions = String((1 << 10) + (1 << 11) + (1 << 16));
const requiredThreadPermissions = String((1n << 10n) + (1n << 16n) + (1n << 38n));

function discordApiFetch(options: {
  permissions?: string;
  overwrites?: unknown[];
  messageAuthorId?: string;
  messageCount?: number;
  messageNonce?: string;
  historyStatus?: number;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === `/api/v10/channels/${channelId}`) {
      return Response.json({ id: channelId, guild_id: guildId, type: 0, permission_overwrites: options.overwrites ?? [] });
    }
    if (url.pathname === `/api/v10/guilds/${guildId}/members/${botUserId}`) {
      return Response.json({ user: { id: botUserId }, roles: [] });
    }
    if (url.pathname === `/api/v10/guilds/${guildId}/roles`) {
      return Response.json([{ id: guildId, permissions: options.permissions ?? requiredPermissions }]);
    }
    if (url.pathname === `/api/v10/channels/${channelId}/messages` && init?.method === 'GET') {
      if (options.historyStatus) return Response.json({ message: 'PRIVATE_HTTP_RESPONSE_BODY' }, { status: options.historyStatus });
      return Response.json(Array.from({ length: options.messageCount ?? 1 }, (_, index) => ({
        id: index === 0 ? '66666666666666666' : (BigInt('66666666666666666') + BigInt(index)).toString(),
        channel_id: channelId,
        author: { id: botUserId, username: 'Dot', bot: true },
        content: 'Hello',
        timestamp: origin.timestamp,
        nonce: options.messageNonce ?? 'stable-nonce',
      })));
    }
    if (url.pathname === `/api/v10/channels/${channelId}/messages/${botMessageId}` && init?.method === 'GET') {
      return Response.json({ id: botMessageId, channel_id: channelId,
        author: { id: options.messageAuthorId ?? botUserId, username: 'Author', bot: options.messageAuthorId ? false : true },
        content: 'Old message', timestamp: origin.timestamp });
    }
    if (url.pathname === `/api/v10/channels/${channelId}/messages/${botMessageId}` && init?.method === 'PATCH') {
      return Response.json({ id: botMessageId, channel_id: channelId,
        author: { id: botUserId, username: 'Dot', bot: true }, content: 'Edited', timestamp: origin.timestamp });
    }
    if (url.pathname === `/api/v10/channels/${channelId}/messages` && init?.method === 'POST') {
      return Response.json({ id: botMessageId, channel_id: channelId,
        author: { id: botUserId, username: 'Dot', bot: true }, content: 'Sent', timestamp: origin.timestamp });
    }
    return new Response(null, { status: 404 });
  });
}

function discordThreadApiFetch(options: {
  threadType?: number;
  parentType?: number;
  threadGuildId?: string;
  parentGuildId?: string;
  locked?: boolean;
  archived?: boolean;
  permissions?: string;
} = {}) {
  const fallback = discordApiFetch({ permissions: options.permissions ?? requiredThreadPermissions });
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === `/api/v10/channels/${threadId}`) {
      return Response.json({
        id: threadId,
        guild_id: options.threadGuildId ?? guildId,
        parent_id: channelId,
        type: options.threadType ?? 11,
        thread_metadata: { archived: options.archived ?? false, locked: options.locked ?? false },
      });
    }
    if (url.pathname === `/api/v10/channels/${channelId}`) {
      return Response.json({
        id: channelId,
        guild_id: options.parentGuildId ?? guildId,
        type: options.parentType ?? 0,
        permission_overwrites: [],
      });
    }
    if (url.pathname === `/api/v10/channels/${threadId}/messages` && init?.method === 'GET') {
      return Response.json([{
        id: botMessageId,
        channel_id: threadId,
        author: { id: botUserId, username: 'Dot', bot: true },
        content: 'Thread reply',
        timestamp: origin.timestamp,
        nonce: 'stable-nonce',
      }]);
    }
    if (url.pathname === `/api/v10/channels/${threadId}/messages` && init?.method === 'POST') {
      return Response.json({ id: botMessageId, channel_id: threadId, author: { id: botUserId, bot: true } });
    }
    return fallback(input, init);
  });
}

describe('Discord reply adapter', () => {
  it('lists validated channel fields for a Discord server', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      id: '88888888888888888', guild_id: origin.guildId, name: 'general', type: 0, parent_id: null, topic: 'not returned',
    }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch);

    await expect(messenger.listGuildChannels(origin.guildId)).resolves.toEqual([{
      id: '88888888888888888', name: 'general', type: 0, parentId: null,
    }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/guilds/11111111111111111/channels');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({ authorization: 'Bot test-bot-token' });
    await expect(messenger.listGuildChannels('not-a-server-id')).rejects.toThrow(/invalid/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('posts only as a reply to the validated origin and suppresses mentions', async () => {
    const fetchMock = vi.fn(async () => fakeResponse('77777777777777777'));
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch);

    await expect(messenger.replyToOrigin(origin, '  Reviewed.  ', async () => true)).resolves.toEqual({
      messageId: '77777777777777777',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/channels/55555555555555555/messages');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({ authorization: 'Bot test-bot-token' });
    expect(JSON.parse(String(init.body))).toEqual({
      content: 'Reviewed.',
      message_reference: {
        message_id: '66666666666666666',
        channel_id: '55555555555555555',
        guild_id: '11111111111111111',
        fail_if_not_exists: true,
      },
      allowed_mentions: { parse: [], replied_user: false },
    });
  });

  it('rejects Discord reply redirects without following the Location', async () => {
    const redirectLocation = 'https://redirect-target.example.test/messages';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('synthetic redirect response', {
      status: 302,
      headers: { location: redirectLocation },
    }));
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch);

    await expect(messenger.replyToOrigin(origin, 'Reply', async () => true)).rejects.toMatchObject({
      name: 'RedirectResponseError',
      status: 302,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('rejects a forged origin and invalid or oversized reply text before calling Discord', async () => {
    const fetchMock = vi.fn(async () => fakeResponse('77777777777777777'));
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch);

    await expect(messenger.replyToOrigin(origin, 'Reply', async () => false)).rejects.toThrow('no longer authorized');
    await expect(messenger.replyToOrigin({ ...origin, eventId: '77777777777777777' }, 'Reply', async () => true)).rejects.toThrow();
    await expect(messenger.replyToOrigin(origin, 'x'.repeat(2001), async () => true)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the bot token is missing', async () => {
    const messenger = new DiscordRestMessenger(undefined, vi.fn() as typeof fetch);
    await expect(messenger.replyToOrigin(origin, 'Reply', async () => true)).rejects.toThrow('Discord transport is not configured');
  });
});

describe('Discord conversation context', () => {
  const parentId = '77777777777777777';
  const requestId = '44444444444444444';
  const sourceId = '44444444444444443';
  const message = (id: string, channel = channelId, content = 'Synthetic discussion') => ({
    id, channel_id: channel, guild_id: guildId, type: 0, content, timestamp: origin.timestamp,
    author: { id: origin.authorId, username: 'Morgan', bot: false },
  });
  const reference = (id: string, channel = channelId) => ({ message_id: id, channel_id: channel, guild_id: guildId });
  function setup(thread = false) {
    const resources = new Map<string, unknown>([
      [`/channels/${channelId}`, { id: channelId, guild_id: guildId, type: thread ? 11 : 0, parent_id: parentId, permission_overwrites: [] }],
      [`/channels/${parentId}`, { id: parentId, guild_id: guildId, type: 0, permission_overwrites: [] }],
      [`/channels/${channelId}/messages/${origin.messageId}`, { ...message(origin.messageId), type: 19,
        ...(thread ? {} : { message_reference: reference(requestId) }) }],
      [`/channels/${channelId}/messages`, [message('66666666666666665', channelId, 'Latest clarification'), message('66666666666666664', channelId, 'Earlier follow-up')]],
      [`/channels/${thread ? parentId : channelId}/messages/${requestId}`, {
        ...message(requestId, thread ? parentId : channelId, 'Please investigate this'), type: 19,
        message_reference: reference(sourceId, thread ? parentId : channelId),
      }],
      [`/channels/${thread ? parentId : channelId}/messages/${sourceId}`, message(sourceId, thread ? parentId : channelId, 'Review the emailed proposal')],
      [`/channels/${parentId}/messages/${channelId}`, {
        ...message(channelId, parentId, 'Which proposal?'), author: { id: botUserId, bot: true }, type: 19,
        message_reference: reference(requestId, parentId),
      }],
    ]);
    const fallback = discordApiFetch();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = url.pathname.replace('/api/v10', '');
      if (resources.has(key)) {
        const value = resources.get(key);
        return value === null ? new Response(null, { status: 404 }) : Response.json(value);
      }
      return fallback(input, init);
    });
    return { resources, fetcher, messenger: new DiscordRestMessenger('test-bot-token', fetcher, botUserId) };
  }

  it.each([false, true])('returns recent context and the original reply chain (thread: %s)', async (thread) => {
    const { messenger, fetcher } = setup(thread);
    const context = await messenger.getOriginContext(origin, async () => true);
    expect(context.recentMessages.map((item) => item.content)).toEqual(['Earlier follow-up', 'Latest clarification']);
    expect(context.referencedMessages.map((item) => item.content)).toEqual([
      ...(thread ? ['Which proposal?'] : []), 'Please investigate this', 'Review the emailed proposal',
    ]);
    const historyUrl = new URL(String(fetcher.mock.calls.find(([url]) => String(url).includes('/messages?'))![0]));
    expect(historyUrl.searchParams.get('before')).toBe(origin.messageId);
    expect(historyUrl.searchParams.get('limit')).toBe('10');
  });

  it('retains recent context and marks a deleted reference as incomplete', async () => {
    const { messenger, resources } = setup();
    resources.set(`/channels/${channelId}/messages/${requestId}`, null);
    await expect(messenger.getOriginContext(origin, async () => true)).resolves.toMatchObject({
      recentMessages: [{ content: 'Earlier follow-up' }, { content: 'Latest clarification' }], referencedMessages: [], incomplete: true,
    });
  });

  it.each(['channel', 'guild', 'forward'])('does not follow a %s reference outside the reply chain', async (kind) => {
    const { messenger, resources, fetcher } = setup();
    resources.set(`/channels/${channelId}/messages/${origin.messageId}`, {
      ...message(origin.messageId), type: 19, message_reference: {
        ...reference(requestId), ...(kind === 'channel' ? { channel_id: parentId } : kind === 'guild' ? { guild_id: parentId } : { type: 1 }),
      },
    });
    expect((await messenger.getOriginContext(origin, async () => true)).referencedMessages).toEqual([]);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith(`/messages/${requestId}`))).toBe(false);
  });

  it.each(['wrong guild', 'private thread', 'DM', 'wrong parent guild', 'wrong message guild', 'wrong author', 'oversized page'])('fails closed for %s', async (kind) => {
    const { messenger, resources } = setup(true);
    if (kind === 'wrong guild' || kind === 'private thread' || kind === 'DM') {
      resources.set(`/channels/${channelId}`, { id: channelId, guild_id: kind === 'wrong guild' ? parentId : guildId,
        type: kind === 'DM' ? 1 : kind === 'private thread' ? 12 : 11, parent_id: parentId });
    } else if (kind === 'wrong parent guild') {
      resources.set(`/channels/${parentId}`, { id: parentId, guild_id: parentId, type: 0, permission_overwrites: [] });
    } else if (kind === 'oversized page') {
      resources.set(`/channels/${channelId}/messages`, Array.from({ length: 11 }, () => message(sourceId)));
    } else {
      resources.set(`/channels/${channelId}/messages/${origin.messageId}`, {
        ...message(origin.messageId), ...(kind === 'wrong message guild' ? { guild_id: parentId } : { author: { id: botUserId } }),
      });
    }
    await expect(messenger.getOriginContext(origin, async () => true)).rejects.toThrow();
  });

  it('performs no Discord reads without current owner/server authorization', async () => {
    const { messenger, fetcher } = setup();
    await expect(messenger.getOriginContext(origin, async () => false)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['long chain', 'cycle'])('bounds a %s instead of following references indefinitely', async (kind) => {
    const { messenger, resources } = setup();
    for (let index = 0; index < 7; index++) {
      const id = (BigInt(requestId) - BigInt(index)).toString();
      const next = kind === 'cycle' ? requestId : (BigInt(id) - 1n).toString();
      resources.set(`/channels/${channelId}/messages/${id}`, { ...message(id), type: 19, message_reference: reference(next) });
    }
    const result = await messenger.getOriginContext(origin, async () => true);
    expect(result.referencedMessages).toHaveLength(kind === 'cycle' ? 1 : 5);
    if (kind === 'long chain') expect(result.incomplete).toBe(true);
  });

  it('requires the bot to have parent-channel history permissions before reading a thread', async () => {
    const { messenger, resources, fetcher } = setup(true);
    resources.set(`/guilds/${guildId}/roles`, [{ id: guildId, permissions: '1024' }]);
    await expect(messenger.getOriginContext(origin, async () => true)).rejects.toThrow('required channel permissions');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false);
  });
});

describe('Discord channel adapter', () => {
  afterEach(() => vi.useRealTimers());

  describe.each(['members/' + botUserId, 'roles'])('permission rate limits on %s', (endpoint) => {
    function limitedFetch(responses: Response[], permissions = requiredPermissions) {
      const fallback = discordApiFetch({ permissions });
      return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith(`/guilds/${guildId}/${endpoint}`) && responses.length) return responses.shift()!;
        return fallback(input, init);
      });
    }

    it.each([
      [{ 'retry-after': '0.025' }, {}, 25],
      [{}, { retry_after: 0.025 }, 25],
      [{ 'retry-after': '0.025' }, { retry_after: 0.04 }, 40],
      [{ 'retry-after': '0.0001' }, {}, 1],
      [{ 'x-ratelimit-reset-after': '0.025' }, {}, 25],
      [{ 'retry-after': 'invalid' }, { retry_after: 0.025 }, 25],
      [{ 'retry-after': '1' }, {}, 1000],
    ] as const)('waits for the full reported delay then retries successfully (%j)', async (headers, body, delayMs) => {
      vi.useFakeTimers();
      const fetchMock = limitedFetch([Response.json(body, { status: 429, headers })]);
      const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
      const result = messenger.listChannelMessages(channelId, '66666666666666666', 1, async () => true);
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(endpoint))).toHaveLength(1);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages?'))).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ messages: [{ content: 'Hello' }], nextBefore: '66666666666666666' });
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(endpoint))).toHaveLength(2);
    });

    it.each([
      ['exhausted', [0.025, 0.05], 2, 50],
      ['over budget', [1.001], 1, 1001],
      ['large delay', [65], 1, 65000],
      ['zero delay exhausted', [0, 0], 2, 0],
    ] as const)('fails closed with a retry delay when %s', async (_label, delays, attempts, retryAfterMs) => {
      vi.useFakeTimers();
      const fetchMock = limitedFetch(delays.map((retry_after) => Response.json({ retry_after, message: 'PRIVATE_BODY' }, { status: 429 })));
      const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
      const result = expect(messenger.listChannelMessages(channelId, '66666666666666666', 1, async () => true)).rejects.toMatchObject({
        stage: 'bot_permissions', reason: 'discord_rate_limited', httpStatus: 429, retryAfterMs,
      });
      await vi.runAllTimersAsync();
      await result;
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(endpoint))).toHaveLength(attempts);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages?'))).toBe(false);
    });

    it.each([{}, { retry_after: -1 }, { retry_after: 'secret' }, { retry_after: 1e300 }])(
      'does not retry without a usable delay (%j)', async (body) => {
        const fetchMock = limitedFetch([Response.json(body, { status: 429 })]);
        const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
        await expect(messenger.listChannelMessages(channelId, undefined, 1, async () => true)).rejects.toMatchObject({
          stage: 'bot_permissions', reason: 'discord_rate_limited', httpStatus: 429, retryAfterMs: undefined,
        });
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(endpoint))).toHaveLength(1);
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages?'))).toBe(false);
      },
    );

    it('uses Retry-After even when the response body is not JSON', async () => {
      vi.useFakeTimers();
      const fetchMock = limitedFetch([new Response('PRIVATE_BODY', { status: 429, headers: { 'retry-after': '0.025' } })]);
      const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
      const result = messenger.listChannelMessages(channelId, undefined, 1, async () => true);
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toMatchObject({ messages: [{ content: 'Hello' }] });
    });

    it('still denies missing permissions after retrying', async () => {
      vi.useFakeTimers();
      const fetchMock = limitedFetch([Response.json({ retry_after: 0.001 }, { status: 429 })], String(1 << 10));
      const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
      const result = expect(messenger.listChannelMessages(channelId, undefined, 1, async () => true)).rejects.toMatchObject({
        stage: 'bot_permissions', reason: 'permission_denied', missingPermissions: ['READ_MESSAGE_HISTORY'],
      });
      await vi.runAllTimersAsync();
      await result;
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages?'))).toBe(false);
    });

    it.each([401, 403])('never retries a genuine HTTP %s denial', async (status) => {
      const fetchMock = limitedFetch([Response.json({ retry_after: 0.001 }, { status })]);
      const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
      await expect(messenger.listChannelMessages(channelId, undefined, 1, async () => true)).rejects.toMatchObject({
        stage: 'bot_permissions', reason: 'discord_http_error', httpStatus: status,
      });
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(endpoint))).toHaveLength(1);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages?'))).toBe(false);
    });
  });

  it.each(['POST', 'PATCH'])('does not retry rate-limited message %s requests', async (method) => {
    const fallback = discordApiFetch();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === method
      ? Response.json({ retry_after: 0.001 }, { status: 429 }) : fallback(input, init));
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
    await expect(method === 'POST'
      ? messenger.sendChannelMessage(channelId, 'Hello', [], 'nonce', async () => true)
      : messenger.editOwnChannelMessage(channelId, botMessageId, 'Hello', [], async () => true)).rejects.toThrow('status 429');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === method)).toHaveLength(1);
  });

  it('does not retry message-history requests', async () => {
    const fetchMock = discordApiFetch({ historyStatus: 429 });
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
    await expect(messenger.listChannelMessages(channelId, undefined, 1, async () => true)).rejects.toMatchObject({
      stage: 'message_history_request', reason: 'discord_http_error', httpStatus: 429,
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/messages?'))).toHaveLength(1);
  });

  it('reads only a bounded page after verifying bot channel permissions and approved-server authorization', async () => {
    const fetchMock = discordApiFetch();
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch, botUserId);
    const authorizeGuild = vi.fn(async (id: string) => id === guildId);
    const page = await messenger.listChannelMessages(channelId, '66666666666666666', 1, authorizeGuild);
    expect(page).toMatchObject({ guildId, nextBefore: '66666666666666666' });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ authorId: botUserId, authorIsBot: true, content: 'Hello' });
    expect(authorizeGuild).toHaveBeenCalledWith(guildId);
    expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ redirect: 'manual' }));
    const historyCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/messages?'));
    expect(String(historyCall?.[0])).toContain('limit=1');
    expect(String(historyCall?.[0])).toContain('before=66666666666666666');
  });

  it('fails closed when required bot permissions are missing or approved-server access is revoked', async () => {
    const noHistory = discordApiFetch({ permissions: String((1 << 10) + (1 << 11)) });
    const messenger = new DiscordRestMessenger('test-bot-token', noHistory as typeof fetch, botUserId);
    await expect(messenger.listChannelMessages(channelId, undefined, 10, async () => true)).rejects.toMatchObject({
      name: 'ChannelReadDiagnosticError',
      stage: 'bot_permissions',
      reason: 'permission_denied',
      missingPermissions: ['READ_MESSAGE_HISTORY'],
      message: 'The bot lacks the required channel permissions.',
    });
    expect(noHistory.mock.calls.some(([input]) => String(input).includes('/messages?'))).toBe(false);

    const revokedFetch = discordApiFetch();
    const revoked = new DiscordRestMessenger('test-bot-token', revokedFetch as typeof fetch, botUserId);
    await expect(revoked.listChannelMessages(channelId, undefined, 10, async () => false)).rejects.toThrow('no longer authorized');
    expect(revokedFetch).toHaveBeenCalledOnce();
    expect(revokedFetch.mock.calls.some(([input]) => String(input).includes('/messages?'))).toBe(false);

    const revokedWriterFetch = discordApiFetch();
    const revokedWriter = new DiscordRestMessenger('test-bot-token', revokedWriterFetch as typeof fetch, botUserId);
    await expect(revokedWriter.validateChannelWrite(channelId, async () => false)).rejects.toThrow('no longer authorized');
    expect(revokedWriterFetch).toHaveBeenCalledOnce();
  });

  it('exposes a safe message-history stage and HTTP status without retaining Discord response bodies', async () => {
    const fetchMock = discordApiFetch({ historyStatus: 403 });
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch, botUserId);
    let failure: unknown;
    try {
      await messenger.listChannelMessages(channelId, undefined, 10, async () => true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'ChannelReadDiagnosticError',
      stage: 'message_history_request',
      reason: 'discord_http_error',
      httpStatus: 403,
    });
    expect(String(failure)).not.toContain('PRIVATE_HTTP_RESPONSE_BODY');
  });

  it('records a rejected redirect status without following it', async () => {
    const fetchMock = discordApiFetch({ historyStatus: 302 });
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch, botUserId);
    let failure: unknown;
    try {
      await messenger.listChannelMessages(channelId, undefined, 10, async () => true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      stage: 'message_history_request',
      reason: 'redirect_rejected',
      httpStatus: 302,
    });
    expect(fetchMock.mock.calls.at(-1)?.[1]?.redirect).toBe('manual');
  });

  it('sends with a stable nonce and disables all mentions unless explicit user IDs are supplied', async () => {
    const fetchMock = discordApiFetch();
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch, botUserId);
    await expect(messenger.sendChannelMessage(channelId, '  Hello <@33333333333333333>  ', [], 'stable-nonce', async () => true))
      .resolves.toEqual({ guildId, messageId: botMessageId });
    const post = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/messages') && init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      content: 'Hello <@33333333333333333>',
      nonce: 'stable-nonce',
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
    });

    const explicitFetch = discordApiFetch();
    const explicit = new DiscordRestMessenger('test-bot-token', explicitFetch as typeof fetch, botUserId);
    await explicit.sendChannelMessage(channelId, '<@33333333333333333>', ['33333333333333333'], 'another-nonce', async () => true);
    const explicitPost = explicitFetch.mock.calls.find(([input, init]) => String(input).endsWith('/messages') && init?.method === 'POST');
    expect(JSON.parse(String(explicitPost?.[1]?.body)).allowed_mentions).toEqual({ users: ['33333333333333333'] });
  });

  it.each([
    ['public', 11, 0],
    ['announcement', 10, 5],
  ])('sends once to the explicitly named archived %s thread', async (_name, threadType, parentType) => {
    const fetchMock = discordThreadApiFetch({ threadType, parentType, archived: true });
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
    const authorizeGuild = vi.fn(async (id: string) => id === guildId);

    await expect(messenger.validateChannelWrite(threadId, authorizeGuild, 'thread')).resolves.toBe(guildId);
    await expect(messenger.sendChannelMessage(threadId, 'Thread result', [], 'stable-nonce', authorizeGuild, 'thread'))
      .resolves.toEqual({ guildId, messageId: botMessageId });
    await expect(messenger.findOwnMessageByNonce(threadId, 'stable-nonce', authorizeGuild, 'thread'))
      .resolves.toMatchObject({ status: 'found', guildId, messageId: botMessageId });

    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(String(posts[0]?.[0])).toContain(`/channels/${threadId}/messages`);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toMatchObject({ content: 'Thread result', nonce: 'stable-nonce', enforce_nonce: true });
    expect(authorizeGuild).toHaveBeenCalledWith(guildId);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/channels/${channelId}/messages`))).toBe(false);
  });

  it('reads a bounded page from the explicitly named thread using its verified parent permissions', async () => {
    const fetchMock = discordThreadApiFetch();
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
    const page = await messenger.listChannelMessages(threadId, undefined, 1, async (id) => id === guildId, 'thread');
    expect(page).toMatchObject({ guildId, messages: [{ channelId: threadId, content: 'Thread reply' }], nextBefore: botMessageId });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/channels/${threadId}/messages?limit=1`))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/channels/${channelId}/messages?limit=1`))).toBe(false);
  });

  it.each([
    ['private thread', { threadType: 12 }],
    ['channel supplied as a thread', { threadType: 0 }],
    ['wrong parent server', { parentGuildId: '99999999999999999' }],
    ['unsupported parent type', { parentType: 15 }],
    ['locked thread', { locked: true }],
    ['locked archived thread', { archived: true, locked: true }],
  ])('rejects an unverified or unsupported %s before posting', async (_name, options) => {
    const fetchMock = discordThreadApiFetch(options);
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
    await expect(messenger.sendChannelMessage(threadId, 'Thread result', [], 'stable-nonce', async () => true, 'thread'))
      .rejects.toThrow();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('requires SEND_MESSAGES_IN_THREADS even when SEND_MESSAGES is granted on the parent', async () => {
    const fetchMock = discordThreadApiFetch({ permissions: String((1n << 10n) + (1n << 11n) + (1n << 16n)) });
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
    await expect(messenger.sendChannelMessage(threadId, 'Thread result', [], 'stable-nonce', async () => true, 'thread'))
      .rejects.toMatchObject({ missingPermissions: ['SEND_MESSAGES_IN_THREADS'] });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('does not treat a thread ID as a channel destination', async () => {
    const fetchMock = discordThreadApiFetch();
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock, botUserId);
    await expect(messenger.sendChannelMessage(threadId, 'Thread result', [], 'stable-nonce', async () => true))
      .rejects.toThrow('Only guild text and announcement channels are supported');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('reconciles a nonce only when Discord reports the matching bot-authored message', async () => {
    const fetchMock = discordApiFetch();
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch, botUserId);
    await expect(messenger.findOwnMessageByNonce(channelId, 'stable-nonce', async () => true))
      .resolves.toEqual({ status: 'found', guildId, messageId: '66666666666666666', scannedMessages: 1, scanLimit: 100 });
  });

  it('reports when nonce reconciliation is limited to recent channel history', async () => {
    const fetchMock = discordApiFetch({ messageCount: 100, messageNonce: 'another-message' });
    const messenger = new DiscordRestMessenger('test-bot-token', fetchMock as typeof fetch, botUserId);
    await expect(messenger.findOwnMessageByNonce(channelId, 'stable-nonce', async () => true))
      .resolves.toEqual({
        status: 'not_found',
        guildId,
        scannedMessages: 100,
        scanLimit: 100,
        olderHistoryMayContainMessage: true,
      });
  });

  it('checks target ownership before editing and sends an explicit mention policy', async () => {
    const otherAuthorFetch = discordApiFetch({ messageAuthorId: '33333333333333333' });
    const otherAuthor = new DiscordRestMessenger('test-bot-token', otherAuthorFetch as typeof fetch, botUserId);
    await expect(otherAuthor.editOwnChannelMessage(channelId, botMessageId, 'Changed', [], async () => true))
      .rejects.toThrow('Only the bot’s own messages can be edited');
    expect(otherAuthorFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);

    const ownFetch = discordApiFetch();
    const own = new DiscordRestMessenger('test-bot-token', ownFetch as typeof fetch, botUserId);
    await expect(own.editOwnChannelMessage(channelId, botMessageId, 'Changed', ['33333333333333333'], async () => true))
      .resolves.toEqual({ guildId, messageId: botMessageId });
    const patch = ownFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      content: 'Changed',
      allowed_mentions: { users: ['33333333333333333'] },
    });
  });
});
