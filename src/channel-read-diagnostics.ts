import { memberAuthorizationFailureReasons } from './origin-store.js';

const stages = [
  'channel_lookup',
  'server_authorization',
  'bot_permissions',
  'message_history_request',
  'message_history_response',
  'message_validation',
  'member_grant_lookup',
  'final_authorization',
] as const;

const reasons = [
  'channel_lookup_failed',
  'discord_http_error',
  'discord_rate_limited',
  'redirect_rejected',
  'request_failed',
  'invalid_response',
  'permission_check_failed',
  'permission_denied',
  'access_denied',
  'authorization_check_failed',
  'member_grant_check_failed',
  ...memberAuthorizationFailureReasons,
  'member_access_rpc_failed',
  'unexpected_failure',
] as const;

const permissions = ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'] as const;

export type ChannelReadStage = typeof stages[number];
export type ChannelReadReason = typeof reasons[number];
export type ChannelReadPermission = typeof permissions[number];

const messages: Record<ChannelReadReason, string> = {
  channel_lookup_failed: 'Discord channel lookup failed.',
  discord_http_error: 'Discord API request failed.',
  discord_rate_limited: 'Discord bot permission checks are rate limited. Retry this page after the reported delay.',
  redirect_rejected: 'Discord API redirect was rejected.',
  request_failed: 'Discord message-history request failed.',
  invalid_response: 'Discord returned an invalid message-history response.',
  permission_check_failed: 'Discord bot permissions could not be verified.',
  permission_denied: 'The bot lacks the required channel permissions.',
  access_denied: 'Discord server access is no longer authorized.',
  authorization_check_failed: 'Discord server authorization could not be verified.',
  member_grant_check_failed: 'Current member grants could not be verified.',
  member_access_unconfigured: 'The bot membership check is not configured.',
  member_access_request_failed: 'The bot membership request failed.',
  member_access_redirect_rejected: 'The bot membership request returned a redirect.',
  member_access_http_error: 'Discord rejected the bot membership request.',
  member_access_invalid_response: 'Discord returned invalid member data.',
  member_access_storage_error: 'Current member grants could not be read.',
  member_access_rpc_failed: 'The member authorization check failed.',
  unexpected_failure: 'Discord channel messages could not be read.',
};

interface ChannelReadDiagnosticDetails {
  httpStatus?: number;
  missingPermissions?: ChannelReadPermission[];
  retryAfterMs?: number;
}

export class ChannelReadDiagnosticError extends TypeError {
  readonly stage: ChannelReadStage;
  readonly reason: ChannelReadReason;
  readonly httpStatus?: number;
  readonly missingPermissions?: ChannelReadPermission[];
  readonly retryAfterMs?: number;

  constructor(
    stage: ChannelReadStage,
    reason: ChannelReadReason,
    details: ChannelReadDiagnosticDetails = {},
  ) {
    const safeStage = stages.includes(stage) ? stage : 'channel_lookup';
    const safeReason = reasons.includes(reason) ? reason : 'unexpected_failure';
    super(messages[safeReason]);
    this.name = 'ChannelReadDiagnosticError';
    this.stage = safeStage;
    this.reason = safeReason;
    if (Number.isInteger(details.httpStatus) && details.httpStatus! >= 100 && details.httpStatus! <= 599) {
      this.httpStatus = details.httpStatus;
    }
    const requestedPermissions = Array.isArray(details.missingPermissions) ? details.missingPermissions : [];
    const missingPermissions = permissions.filter((permission) => requestedPermissions.includes(permission));
    if (missingPermissions.length) this.missingPermissions = missingPermissions;
    if (safeStage === 'bot_permissions' && safeReason === 'discord_rate_limited' && this.httpStatus === 429 &&
        Number.isSafeInteger(details.retryAfterMs) && details.retryAfterMs! >= 0) {
      this.retryAfterMs = details.retryAfterMs;
    }
  }
}

/** Revalidate at the output boundary, including errors mutated after construction. */
export function channelReadDiagnostic(error: ChannelReadDiagnosticError) {
  const safe = new ChannelReadDiagnosticError(error.stage, error.reason, error);
  return {
    stage: safe.stage,
    reason: safe.reason,
    ...(safe.httpStatus !== undefined ? { httpStatus: safe.httpStatus } : {}),
    ...(safe.missingPermissions ? { missingPermissions: safe.missingPermissions } : {}),
    ...(safe.stage === 'bot_permissions' && safe.reason === 'discord_rate_limited' && safe.httpStatus === 429
      ? { retryable: true, ...(safe.retryAfterMs !== undefined ? { retryAfterMs: safe.retryAfterMs } : {}) } : {}),
  };
}

/** Log only fixed diagnostic fields; never forward arbitrary error data. */
export function logChannelReadDiagnostic(error: ChannelReadDiagnosticError): void {
  const safe = channelReadDiagnostic(error);
  const record: Record<string, unknown> = {
    event: 'discord_channel_read_failure',
    stage: safe.stage,
    reason: safe.reason,
  };
  if (safe.httpStatus !== undefined) record.http_status = safe.httpStatus;
  if (safe.missingPermissions) record.missing_permissions = safe.missingPermissions;
  if (safe.retryable) record.retryable = true;
  if (safe.retryAfterMs !== undefined) record.retry_after_ms = safe.retryAfterMs;
  console.info(record);
}
