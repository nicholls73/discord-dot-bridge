import { describe, expect, it } from 'vitest';
import { ingestMention, type OriginStore } from '../src/origin-store.js';
import type { GatewayMentionCandidate, OriginMessage } from '../src/policy.js';

const BOT = '22222222222222222';

function candidate(overrides: Partial<GatewayMentionCandidate> = {}): GatewayMentionCandidate {
  return {
    guildId: '11111111111111111',
    channelId: '55555555555555555',
    messageId: '66666666666666666',
    authorId: '33333333333333333',
    authorDisplayName: 'Synthetic user',
    authorIsBot: false,
    mentionedUserIds: [BOT],
    content: 'Please inspect this issue.',
    timestamp: '2026-10-04T12:00:00.000Z',
    ...overrides,
  };
}

function memoryStore(): OriginStore {
  const records = new Map<string, OriginMessage>();
  return {
    async recordOriginOnce(origin) {
      if (records.has(origin.eventId)) return 'duplicate';
      records.set(origin.eventId, origin);
      return 'accepted';
    },
    async getOrigin(eventId) { return records.get(eventId) ?? null; },
    async isOriginAuthorized() { return true; },
  };
}

describe('mention origin store', () => {
  it('accepts once and deduplicates the same Discord message id', async () => {
    const store = memoryStore();
    await expect(ingestMention(candidate(), BOT, store)).resolves.toEqual({
      status: 'accepted', eventId: '66666666666666666',
    });
    await expect(ingestMention(candidate(), BOT, store)).resolves.toEqual({
      status: 'duplicate', eventId: '66666666666666666',
    });
    const origin = await store.getOrigin('66666666666666666');
    expect(origin?.messageUrl).toBe('https://discord.com/channels/11111111111111111/55555555555555555/66666666666666666');
  });

  it('rejects unconfigured, bot-authored, and non-mention events without storing them', async () => {
    const store = memoryStore();
    await expect(ingestMention(candidate(), undefined, store)).resolves.toMatchObject({ status: 'rejected' });
    await expect(ingestMention(candidate({ authorIsBot: true }), BOT, store)).resolves.toMatchObject({ status: 'rejected' });
    await expect(ingestMention(candidate({ mentionedUserIds: [] }), BOT, store)).resolves.toMatchObject({ status: 'rejected' });
    await expect(store.getOrigin('66666666666666666')).resolves.toBeNull();
  });

  it('rejects origins when runtime authorization denies the sender', async () => {
    const store = memoryStore();
    store.recordOriginOnce = async () => 'rejected';
    await expect(ingestMention(candidate(), BOT, store)).resolves.toEqual({
      status: 'rejected', reason: 'author_not_allowed',
    });
  });
});
