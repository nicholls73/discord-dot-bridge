import { describe, expect, it, vi } from 'vitest';
import { ChannelReadDiagnosticError, channelReadDiagnostic, logChannelReadDiagnostic } from '../src/channel-read-diagnostics.js';

describe('channel read diagnostics', () => {
  it.each([-1, Infinity, NaN, 0.1, Number.MAX_SAFE_INTEGER + 1, 'private-delay'])('omits invalid retry delays (%s)', (retryAfterMs) => {
    const error = Object.assign(new ChannelReadDiagnosticError('bot_permissions', 'discord_rate_limited', { httpStatus: 429 }), { retryAfterMs });
    expect(channelReadDiagnostic(error)).toEqual({
      stage: 'bot_permissions', reason: 'discord_rate_limited', httpStatus: 429, retryable: true,
    });
  });

  it('does not trust mutated diagnostic values or arbitrary metadata', () => {
    const error = Object.assign(new ChannelReadDiagnosticError('bot_permissions', 'permission_denied'), {
      stage: 'PRIVATE_STAGE', reason: 'PRIVATE_REASON', httpStatus: 'PRIVATE_STATUS',
      retryAfterMs: 1000, missingPermissions: ['PRIVATE_PERMISSION'], retryable: true,
    });
    expect(channelReadDiagnostic(error)).toEqual({ stage: 'channel_lookup', reason: 'unexpected_failure' });
    expect(channelReadDiagnostic(new ChannelReadDiagnosticError('bot_permissions', 'discord_http_error', { httpStatus: 403, retryAfterMs: 1000 })))
      .toEqual({ stage: 'bot_permissions', reason: 'discord_http_error', httpStatus: 403 });
  });

  it('logs only the allowlisted stage, reason, status, and permission names', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = Object.assign(
      new ChannelReadDiagnosticError('bot_permissions', 'permission_denied', {
        missingPermissions: ['READ_MESSAGE_HISTORY'],
      }),
      {
        message: 'PRIVATE_MESSAGE_CONTENT and Bot secret-token',
        channelId: '55555555555555555',
        authorization: 'Bot secret-token',
        responseBody: 'sensitive Discord response body',
      },
    );

    logChannelReadDiagnostic(error);

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: 'discord_channel_read_failure',
      stage: 'bot_permissions',
      reason: 'permission_denied',
      missing_permissions: ['READ_MESSAGE_HISTORY'],
    });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/PRIVATE_MESSAGE_CONTENT|secret-token|sensitive|55555555555555555/);
  });

  it('rejects invalid status values and unrecognized permissions', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = Object.assign(
      new ChannelReadDiagnosticError('bot_permissions', 'permission_denied'),
      { httpStatus: 700, missingPermissions: ['ADMINISTRATOR', 'READ_MESSAGE_HISTORY'] },
    );

    logChannelReadDiagnostic(error);

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: 'discord_channel_read_failure',
      stage: 'bot_permissions',
      reason: 'permission_denied',
      missing_permissions: ['READ_MESSAGE_HISTORY'],
    });
  });
});
