import { describe, expect, it } from 'vitest';
import { DiscordGatewayProtocol } from '../src/gateway.js';

const gateway = (op: number, data: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ op, d: data, ...extra });

describe('Discord Gateway protocol', () => {
  it('identifies with only guild messages after HELLO and persists READY session state', () => {
    const protocol = new DiscordGatewayProtocol('test-bot-token', null, () => 0.5);
    const hello = protocol.receive(gateway(10, { heartbeat_interval: 40_000 }));
    expect(protocol.isReady).toBe(false);
    expect(hello).toEqual([
      { type: 'send', payload: { op: 2, d: {
        token: 'test-bot-token',
        intents: 512,
        properties: { os: 'cloudflare-workers', browser: 'discord-dot', device: 'discord-dot' },
      } } },
      { type: 'schedule', delayMs: 20_000 },
    ]);

    const ready = protocol.receive(gateway(0, {
      session_id: 'session-test',
      resume_gateway_url: 'wss://gateway-us-east1-a.discord.gg',
    }, { s: 9, t: 'READY' }));
    expect(ready.find((command) => command.type === 'session')).toEqual({
      type: 'session',
      value: { sequence: 9, sessionId: 'session-test', resumeUrl: 'wss://gateway-us-east1-a.discord.gg/?v=10&encoding=json' },
    });
    expect(protocol.connectUrl).toBe('wss://gateway-us-east1-a.discord.gg/?v=10&encoding=json');
    expect(protocol.isReady).toBe(true);
  });

  it('resumes after reconnect and sends sequenced heartbeats with acknowledgement checks', () => {
    const saved = { sequence: 17, sessionId: 'session-test', resumeUrl: 'wss://gateway.discord.gg/?v=10&encoding=json' };
    const protocol = new DiscordGatewayProtocol('test-bot-token', saved, () => 0.5);
    expect(protocol.receive(gateway(10, { heartbeat_interval: 30_000 }))[0]).toEqual({
      type: 'send', payload: { op: 6, d: { token: 'test-bot-token', session_id: 'session-test', seq: 17 } },
    });
    expect(protocol.receive(gateway(11, null))).toEqual([{ type: 'session', value: saved }]);
    expect(protocol.alarm()).toEqual([
      { type: 'send', payload: { op: 1, d: 17 } },
      { type: 'schedule', delayMs: 30_000 },
    ]);
    expect(protocol.alarm()).toEqual([{ type: 'close', code: 4000, reason: 'heartbeat acknowledgement timed out' }]);
    expect(protocol.isReady).toBe(false);
  });

  it('extracts only direct user mentions with a guild message origin', () => {
    const protocol = new DiscordGatewayProtocol('test-bot-token');
    protocol.receive(gateway(10, { heartbeat_interval: 30_000 }));
    const commands = protocol.receive(gateway(0, {
      id: '66666666666666666',
      guild_id: '11111111111111111',
      channel_id: '55555555555555555',
      timestamp: '2026-10-04T12:00:00.000Z',
      content: '<@22222222222222222> review this',
      author: { id: '33333333333333333', username: 'Synthetic user', bot: false },
      member: { nick: 'Synthetic user', roles: ['44444444444444444'] },
      mentions: [{ id: '22222222222222222' }],
    }, { s: 18, t: 'MESSAGE_CREATE' }));
    expect(commands.find((command) => command.type === 'mention')).toEqual({
      type: 'mention',
      candidate: {
        guildId: '11111111111111111',
        channelId: '55555555555555555',
        messageId: '66666666666666666',
        authorId: '33333333333333333',
        authorDisplayName: 'Synthetic user',
        authorIsBot: false,
        mentionedUserIds: ['22222222222222222'],
        content: '<@22222222222222222> review this',
        timestamp: '2026-10-04T12:00:00.000Z',
      },
    });
  });

  it('honors server reconnects and resets invalid or terminal sessions correctly', () => {
    const protocol = new DiscordGatewayProtocol('test-bot-token', {
      sequence: 3, sessionId: 'session-test', resumeUrl: 'wss://gateway.discord.gg/',
    }, () => 0.5);
    expect(protocol.receive(gateway(7, null))).toEqual([{ type: 'close', code: 4000, reason: 'Discord requested reconnect' }]);
    expect(protocol.closed(4009)).toMatchObject([
      { type: 'session', value: { sequence: null, sessionId: null, resumeUrl: null } },
      { type: 'schedule', delayMs: 1_000 },
    ]);
    expect(protocol.isReady).toBe(false);
    expect(protocol.closed(4014)).toEqual([{ type: 'terminal', code: 4014 }]);

    const invalidSession = new DiscordGatewayProtocol('test-bot-token', {
      sequence: 3, sessionId: 'session-test', resumeUrl: 'wss://gateway.discord.gg/',
    }, () => 0.5);
    const commands = invalidSession.receive(gateway(9, false));
    expect(commands).toEqual([
      { type: 'session', value: { sequence: null, sessionId: null, resumeUrl: null } },
      { type: 'schedule', delayMs: 3_000 },
      { type: 'close', code: 4000, reason: 'invalid session; reconnect after jitter' },
    ]);
  });
});
