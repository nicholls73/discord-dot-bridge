import { isAllowedOrigin, toOriginMessage, validateMentionCandidate } from './policy.js';
import type { EventAuthorizationReference } from './events.js';
import type { GatewayMentionCandidate, OriginMessage } from './policy.js';

export interface OriginStore {
  recordOriginOnce(origin: OriginMessage): Promise<'accepted' | 'duplicate' | 'rejected'>;
  getOrigin(eventId: string): Promise<OriginMessage | null>;
  isOriginAuthorized(origin: OriginMessage): Promise<boolean>;
}

export type IngestMentionResult =
  | { status: 'rejected'; reason: string }
  | { status: 'accepted' | 'duplicate'; eventId: string };

export async function ingestMention(
  candidate: GatewayMentionCandidate,
  botUserId: string | undefined,
  store: OriginStore,
): Promise<IngestMentionResult> {
  const rejection = validateMentionCandidate(candidate, botUserId);
  if (rejection) return { status: 'rejected', reason: rejection };

  const origin = toOriginMessage(candidate);
  if (!isAllowedOrigin(origin, botUserId)) return { status: 'rejected', reason: 'origin_not_allowed' };
  const result = await store.recordOriginOnce(origin);
  return result === 'rejected'
    ? { status: 'rejected', reason: 'author_not_allowed' }
    : { status: result, eventId: origin.eventId };
}

export type ReplyState = { status: 'reply_started' } | { status: 'replied'; replyMessageId: string };

export interface MentionRecoveryStore {
  listPendingMentions(principal: string, authorization: EventAuthorizationReference, limit: number, cursor?: string): Promise<{
    events: Array<{ eventId: string; messageId: string; timestamp: string; status: 'pending' | 'reply_started' }>;
    nextCursor: string | null;
  }>;
  beginReply(origin: OriginMessage): Promise<ReplyState | null>;
  stopTyping?(origin: OriginMessage): Promise<void>;
  completeReply(origin: OriginMessage, replyMessageId: string): Promise<void>;
}

export interface ChannelAccessStore {
  isChannelAuthorized(ownerEmail: string, guildId: string): Promise<boolean>;
  isAuthorizedMember(guildId: string, userId: string): Promise<MemberAuthorizationResult>;
}

export const memberAuthorizationFailureReasons = [
  'member_access_unconfigured',
  'member_access_request_failed',
  'member_access_redirect_rejected',
  'member_access_http_error',
  'member_access_invalid_response',
  'member_access_storage_error',
] as const;

export type MemberAuthorizationFailureReason = typeof memberAuthorizationFailureReasons[number];

export type MemberAuthorizationResult =
  | { status: 'authorized' }
  | { status: 'denied' }
  | { status: 'unavailable'; reason: MemberAuthorizationFailureReason; httpStatus?: number };

export function isMemberAuthorizationResult(value: unknown): value is MemberAuthorizationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<MemberAuthorizationResult>;
  if (result.status === 'authorized' || result.status === 'denied') return true;
  if (result.status !== 'unavailable' || typeof result.reason !== 'string') return false;
  if (!memberAuthorizationFailureReasons.includes(result.reason as MemberAuthorizationFailureReason)) return false;
  if (result.reason === 'member_access_http_error' || result.reason === 'member_access_redirect_rejected') {
    return Number.isInteger(result.httpStatus) && result.httpStatus! >= 100 && result.httpStatus! <= 599;
  }
  return result.httpStatus === undefined;
}

export type StandaloneMessageState =
  | { status: 'new' }
  | { status: 'message_started' }
  | { status: 'sent'; messageId: string };

export interface StandaloneMessageStore {
  beginStandaloneMessage(
    ownerEmail: string,
    idempotencyKey: string,
    channelId: string,
    requestHash: string,
    nonce: string,
  ): Promise<StandaloneMessageState>;
  completeStandaloneMessage(
    ownerEmail: string,
    idempotencyKey: string,
    channelId: string,
    requestHash: string,
    messageId: string,
  ): Promise<void>;
}
