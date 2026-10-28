import type { GatewayMentionCandidate } from './policy.js';

export interface GatewaySession {
  sequence: number | null;
  sessionId: string | null;
  resumeUrl: string | null;
}

export interface GatewayPayload {
  op?: unknown;
  d?: unknown;
  s?: unknown;
  t?: unknown;
}

export type GatewayCommand =
  | { type: 'send'; payload: Record<string, unknown> }
  | { type: 'schedule'; delayMs: number }
  | { type: 'close'; code: number; reason: string }
  | { type: 'session'; value: GatewaySession }
  | { type: 'mention'; candidate: GatewayMentionCandidate }
  | { type: 'terminal'; code: number };

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
// Direct bot mentions include content without the privileged MESSAGE_CONTENT intent.
const GUILD_MESSAGES_INTENT = 1 << 9;
const TERMINAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Reducer for Discord Gateway v10. The caller owns the socket and durable alarm. */
export class DiscordGatewayProtocol {
  private sequence: number | null;
  private sessionId: string | null;
  private resumeUrl: string | null;
  private heartbeatIntervalMs = 0;
  private awaitingHeartbeatAck = false;
  private reconnectAttempt = 0;
  private helloReceived = false;
  private ready = false;

  constructor(
    private readonly token: string,
    session: GatewaySession | null = null,
    private readonly random: () => number = Math.random,
    gatewayUrl = GATEWAY_URL,
  ) {
    this.sequence = session?.sequence ?? null;
    this.sessionId = session?.sessionId ?? null;
    this.resumeUrl = session?.resumeUrl ?? null;
    this.gatewayUrl = normalizeResumeUrl(gatewayUrl);
  }

  private readonly gatewayUrl: string;

  get connectUrl(): string {
    return this.sessionId && this.resumeUrl ? this.resumeUrl : this.gatewayUrl;
  }

  get savedSession(): GatewaySession {
    return { sequence: this.sequence, sessionId: this.sessionId, resumeUrl: this.resumeUrl };
  }

  get isReady(): boolean {
    return this.ready;
  }

  receive(raw: string): GatewayCommand[] {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw) as GatewayPayload;
    } catch {
      return [];
    }
    if (!Number.isInteger(payload.op)) return [];
    if (Number.isInteger(payload.s)) this.sequence = payload.s as number;

    const commands: GatewayCommand[] = [];
    const op = payload.op as number;
    if (op === 10) {
      const interval = (payload.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval;
      if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 1_000 || interval > 300_000) {
        this.ready = false;
        return [{ type: 'close', code: 4000, reason: 'invalid heartbeat interval' }];
      }
      this.heartbeatIntervalMs = interval;
      this.helloReceived = true;
      this.awaitingHeartbeatAck = false;
      if (this.sessionId && this.sequence !== null) {
        commands.push({ type: 'send', payload: {
          op: 6,
          d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
        } });
      } else {
        commands.push({ type: 'send', payload: {
          op: 2,
          d: { token: this.token, intents: GUILD_MESSAGES_INTENT, properties: { os: 'cloudflare-workers', browser: 'discord-dot', device: 'discord-dot' } },
        } });
      }
      const jitter = Math.min(1, Math.max(0, this.random()));
      commands.push({ type: 'schedule', delayMs: Math.floor(interval * jitter) });
      return commands;
    }

    if (op === 11) {
      this.awaitingHeartbeatAck = false;
      return [{ type: 'session', value: this.savedSession }];
    }
    if (op === 1) {
      commands.push({ type: 'send', payload: { op: 1, d: this.sequence } });
      this.awaitingHeartbeatAck = true;
      commands.push({ type: 'schedule', delayMs: this.heartbeatIntervalMs || 30_000 });
      return commands;
    }
    if (op === 7) {
      this.ready = false;
      return [{ type: 'close', code: 4000, reason: 'Discord requested reconnect' }];
    }
    if (op === 9) {
      this.ready = false;
      const resumable = payload.d === true;
      if (!resumable) this.clearSession();
      return [
        { type: 'session', value: this.savedSession },
        { type: 'schedule', delayMs: 1_000 + Math.floor(this.random() * 4_000) },
        { type: 'close', code: 4000, reason: 'invalid session; reconnect after jitter' },
      ];
    }
    if (op !== 0 || typeof payload.t !== 'string') {
      return this.sequence === null ? [] : [{ type: 'session', value: this.savedSession }];
    }

    const data = payload.d as Record<string, unknown> | null;
    if (payload.t === 'READY' && data && typeof data.session_id === 'string' && typeof data.resume_gateway_url === 'string') {
      this.sessionId = data.session_id;
      this.resumeUrl = normalizeResumeUrl(data.resume_gateway_url);
      this.reconnectAttempt = 0;
      this.ready = true;
      commands.push({ type: 'session', value: this.savedSession });
    } else if (payload.t === 'RESUMED') {
      this.reconnectAttempt = 0;
      this.ready = true;
      commands.push({ type: 'session', value: this.savedSession });
    } else if (payload.t === 'MESSAGE_CREATE' && data) {
      const candidate = toMentionCandidate(data);
      if (candidate) commands.push({ type: 'mention', candidate });
    }
    if (this.sequence !== null) commands.push({ type: 'session', value: this.savedSession });
    return dedupeSessionCommand(commands);
  }

  alarm(): GatewayCommand[] {
    if (!this.helloReceived) {
      this.ready = false;
      return [{ type: 'close', code: 4000, reason: 'Gateway HELLO timed out' }];
    }
    if (this.awaitingHeartbeatAck) {
      this.ready = false;
      return [{ type: 'close', code: 4000, reason: 'heartbeat acknowledgement timed out' }];
    }
    this.awaitingHeartbeatAck = true;
    return [
      { type: 'send', payload: { op: 1, d: this.sequence } },
      { type: 'schedule', delayMs: this.heartbeatIntervalMs },
    ];
  }

  closed(code: number): GatewayCommand[] {
    this.helloReceived = false;
    this.awaitingHeartbeatAck = false;
    this.ready = false;
    if (TERMINAL_CLOSE_CODES.has(code)) return [{ type: 'terminal', code }];
    if (code === 4007 || code === 4009) this.clearSession();
    const ceiling = Math.min(30_000, 1_000 * (2 ** Math.min(this.reconnectAttempt, 5)));
    this.reconnectAttempt += 1;
    return [
      { type: 'session', value: this.savedSession },
      { type: 'schedule', delayMs: 1_000 + Math.floor(this.random() * Math.max(1, ceiling - 999)) },
    ];
  }

  private clearSession() {
    this.sequence = null;
    this.sessionId = null;
    this.resumeUrl = null;
  }
}

function normalizeResumeUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const isDiscordHost = host === 'discord.gg' || host.endsWith('.discord.gg') ||
      host === 'discord.com' || host.endsWith('.discord.com');
    if (url.protocol !== 'wss:' || !isDiscordHost || url.username || url.password) {
      return GATEWAY_URL;
    }
    url.searchParams.set('v', '10');
    url.searchParams.set('encoding', 'json');
    return url.toString();
  } catch {
    return GATEWAY_URL;
  }
}

function toMentionCandidate(data: Record<string, unknown>): GatewayMentionCandidate | null {
  const author = data.author as Record<string, unknown> | undefined;
  const member = data.member as Record<string, unknown> | undefined;
  const mentions = data.mentions;
  if (!author || typeof author.id !== 'string' || typeof data.guild_id !== 'string' ||
      typeof data.channel_id !== 'string' || typeof data.id !== 'string' || typeof data.timestamp !== 'string' ||
      typeof data.content !== 'string' || !Array.isArray(mentions)) return null;
  const authorDisplayName = typeof member?.nick === 'string' ? member.nick
    : typeof author.global_name === 'string' ? author.global_name
      : typeof author.username === 'string' ? author.username : '';
  return {
    guildId: data.guild_id,
    channelId: data.channel_id,
    messageId: data.id,
    authorId: author.id,
    authorDisplayName,
    authorIsBot: author.bot === true,
    mentionedUserIds: mentions.flatMap((mention) => {
      if (!mention || typeof mention !== 'object') return [];
      const id = (mention as { id?: unknown }).id;
      return typeof id === 'string' ? [id] : [];
    }),
    content: data.content,
    timestamp: data.timestamp,
  };
}

function dedupeSessionCommand(commands: GatewayCommand[]): GatewayCommand[] {
  let found = false;
  return commands.filter((command) => {
    if (command.type !== 'session') return true;
    if (found) return false;
    found = true;
    return true;
  });
}
