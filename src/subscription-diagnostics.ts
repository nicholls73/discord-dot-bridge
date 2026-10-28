const phases = ['request', 'authorization', 'validation', 'callback', 'storage', 'gateway'] as const;
const reasons = [
  'started', 'succeeded', 'failed', 'configuration_missing', 'rejected',
  'scopes_missing', 'binding_missing', 'reference_missing', 'cached', 'redirect',
  'transport_failed', 'http_error', 'challenge_failed', 'dns_failed', 'socket_failed',
  'peer_missing', 'peer_mismatch', 'dns_resolved', 'peer_verified', 'response_received',
  'callback_cache_read', 'callback_cache_write',
  'returned', 'terminal_stopped', 'request_failed', 'response_failed', 'timeout',
] as const;

export type SubscriptionPhase = typeof phases[number];
type SubscriptionReason = typeof reasons[number];

interface DiagnosticDetails {
  httpStatus?: number;
  rpcCode?: number;
  canRead?: boolean;
  canReply?: boolean;
  subscriptionStored?: boolean;
}

/** Reconstruct the record so request data and arbitrary error text cannot enter logs. */
export function logSubscriptionDiagnostic(
  phase: SubscriptionPhase,
  reason: SubscriptionReason,
  details: DiagnosticDetails = {},
): void {
  const record: Record<string, string | number | boolean> = {
    event: 'discord_subscription_diagnostic',
    phase: phases.includes(phase) ? phase : 'request',
    reason: reasons.includes(reason) ? reason : 'failed',
  };
  if (Number.isInteger(details.httpStatus) && details.httpStatus! >= 100 && details.httpStatus! <= 599) {
    record.http_status = details.httpStatus!;
  }
  if (Number.isInteger(details.rpcCode) && details.rpcCode! >= -32768 && details.rpcCode! <= -32000) {
    record.rpc_code = details.rpcCode!;
  }
  for (const key of ['canRead', 'canReply', 'subscriptionStored'] as const) {
    if (typeof details[key] === 'boolean') record[key] = details[key];
  }
  console.info(record);
}
