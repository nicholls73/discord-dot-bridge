import type { OriginMessage } from './policy.js';

export const MENTION_EVENT_NAME = 'discord.message.mentioned' as const;

export interface EventAuthorizationReference {
  grantId: string;
  tokenId: string;
  clientId: string;
  audience: string;
}

export interface EventSubscriptionIdentity {
  id: string;
  principal: string;
  name: typeof MENTION_EVENT_NAME;
  arguments: Record<string, never>;
  url: string;
}

export interface EventSubscription extends EventSubscriptionIdentity {
  secret: string;
  refreshBefore: string;
  authorization?: EventAuthorizationReference;
  recoveryId?: string;
  previousSecret?: string;
  previousSecretUntil?: number;
}

export interface MentionEvent {
  eventId: string;
  name: typeof MENTION_EVENT_NAME;
  timestamp: string;
  data: {
    event_id: string;
    message_id: string;
    message_url: string;
    guild_id: string;
    channel_id: string;
    author_id: string;
    author_display_name: string;
    text: string;
  };
  cursor: null;
}

export function toMentionEvent(origin: OriginMessage): MentionEvent {
  return {
    eventId: origin.eventId,
    name: MENTION_EVENT_NAME,
    timestamp: origin.timestamp,
    data: {
      event_id: origin.eventId,
      message_id: origin.messageId,
      message_url: origin.messageUrl,
      guild_id: origin.guildId,
      channel_id: origin.channelId,
      author_id: origin.authorId,
      author_display_name: origin.authorDisplayName,
      text: origin.content,
    },
    cursor: null,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function makeSubscriptionId(
  principal: string,
  url: string,
  name: typeof MENTION_EVENT_NAME,
  arguments_: Record<string, never>,
): Promise<string> {
  const identity = `${principal}\n${url}\n${name}\n${canonicalJson(arguments_)}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
  const encoded = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sub_${encoded}`;
}
