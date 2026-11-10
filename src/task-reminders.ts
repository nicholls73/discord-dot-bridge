import type { DiscordChannelMessage } from './discord.js';

export const TASK_CAPTURED_EVENT_NAME = 'discord.task.captured' as const;
export const TASK_REMINDER_EVENT_NAME = 'discord.task.reminder' as const;
export const TASK_MANAGE_SCOPE = 'discord:task:manage';
export const TASK_SWEEP_INTERVAL_MS = 15 * 60_000;
export const TASK_INITIAL_REMINDER_MS = 24 * 60 * 60_000;
export const TASK_REPEAT_REMINDER_MS = 7 * 24 * 60 * 60_000;
export const TASK_MAX_REMINDERS = 3;
export const TASK_CLOSED_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const TASK_LOOKBACK_MS = 14 * 24 * 60 * 60_000;

const MAX_CHANNELS = 10;
const MAX_TASKS = 500;
const TASK_ACTION = String.raw`(?:review|check|send|share|update|write|deploy|test|prepare|create|fix|confirm|call|schedule|invoice|follow up|investigate|respond|deliver|approve|book|coordinate|upload|look into)`;

export interface TaskReminderMessage extends DiscordChannelMessage {
  guildId: string;
  mentionedUserIds: string[];
  replyToMessageId?: string;
  threadId?: string;
}

export type TrackedTaskStatus = 'open' | 'completed' | 'cancelled' | 'reassigned';

export interface TrackedTask {
  id: string;
  revision: number;
  status: TrackedTaskStatus;
  ownership: 'assigned' | 'commitment';
  confidence: 'high';
  ownerId: string;
  sourceAuthorId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  messageUrl: string;
  threadId?: string;
  threadCursor?: string;
  threadScan?: {
    before: string;
    highWaterId: string;
    messages: TaskReminderMessage[];
  };
  text: string;
  createdAt: number;
  lastActivityAt: number;
  nextReminderAt: number;
  lastReminderAt?: number;
  remindersSent: number;
}

export type TaskEventName = typeof TASK_CAPTURED_EVENT_NAME | typeof TASK_REMINDER_EVENT_NAME;

export interface TaskReminderEvent {
  eventId: string;
  name: TaskEventName;
  timestamp: string;
  data: {
    task_id: string;
    revision: number;
    status: TrackedTaskStatus;
    ownership: 'assigned' | 'commitment';
    confidence: 'high';
    text: string;
    message_url: string;
    reminders_sent: number;
  };
  cursor: null;
}

export function parseTaskReminderChannelIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const ids = value.split(',').map((id) => id.trim());
  if (ids.length > MAX_CHANNELS || ids.some((id) => !/^\d{17,20}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new TypeError(`TASK_REMINDER_CHANNEL_IDS must contain at most ${MAX_CHANNELS} unique Discord channel IDs.`);
  }
  return ids;
}

export function taskKey(taskId: string): string {
  return `task:${taskId}`;
}

export function detectTask(message: TaskReminderMessage, ownerId: string): Omit<TrackedTask, 'revision' | 'status' | 'createdAt' | 'lastActivityAt' | 'nextReminderAt' | 'remindersSent'> | null {
  if (message.authorIsBot || message.authorId === ownerId || !message.content.trim()) return null;
  const text = actionableText(message.content);
  if (!text) return null;
  const mention = `<@!?${escapeRegExp(ownerId)}>`;
  const assignment = new RegExp(String.raw`^\s*${mention}\s*[,;:]?\s*(?:(?:can|could|would|will) you|please|are you able to)\s+${TASK_ACTION}\b`, 'iu').test(text);
  if (!assignment || !message.mentionedUserIds.includes(ownerId)) return null;
  return taskFrom(message, ownerId, 'assigned');
}

export function detectCommitment(message: TaskReminderMessage, ownerId: string): Omit<TrackedTask, 'revision' | 'status' | 'createdAt' | 'lastActivityAt' | 'nextReminderAt' | 'remindersSent'> | null {
  if (message.authorIsBot || message.authorId !== ownerId || !message.content.trim()) return null;
  const text = actionableText(message.content);
  if (!text) return null;
  const promise = new RegExp(String.raw`^\s*(?:i(?:['’]ll| will| am going to|['’]m going to)\s+${TASK_ACTION}\b|i can take (?:care of|on)\b|leave it with me\b|on me\b)`, 'iu').test(text);
  return promise ? taskFrom(message, ownerId, 'commitment') : null;
}

export function detectTaskCandidate(message: TaskReminderMessage, ownerId: string) {
  return detectTask(message, ownerId) ?? detectCommitment(message, ownerId);
}

export function applyTaskFollowup(task: TrackedTask, message: TaskReminderMessage, ownerId: string, now = Date.parse(message.timestamp)): TrackedTask {
  if (task.status !== 'open' || message.id === task.messageId || Date.parse(message.timestamp) <= task.lastActivityAt || !isTaskFollowup(task, message)) {
    return task;
  }
  const text = (actionableText(message.content) ?? message.content).toLowerCase();
  if (message.authorId === ownerId && /\b(?:done|completed|finished|sent|reviewed|submitted|deployed|resolved|handled|fixed|uploaded|approved)\b/u.test(text)) {
    return { ...task, revision: task.revision + 1, status: 'completed', lastActivityAt: now };
  }
  if ((message.authorId === ownerId || message.authorId === task.sourceAuthorId) &&
      /\b(?:cancel(?:led|ed)?|no longer needed|ignore (?:this|that)|drop (?:this|that)|not needed)\b/u.test(text)) {
    return { ...task, revision: task.revision + 1, status: 'cancelled', lastActivityAt: now };
  }
  if ((message.authorId === ownerId || message.authorId === task.sourceAuthorId) &&
      /\b(?:reassign(?:ed)?|someone else|[^.!?\n]{1,80} will (?:handle|take over|do|own) (?:this|that|it))\b/u.test(text)) {
    return { ...task, revision: task.revision + 1, status: 'reassigned', lastActivityAt: now };
  }
  const promisedDelay = promisedDelayMs(text, now);
  if ((message.authorId === ownerId || message.authorId === task.sourceAuthorId) && promisedDelay !== null) {
    return {
      ...task,
      revision: task.revision + 1,
      lastActivityAt: now,
      nextReminderAt: now + promisedDelay + TASK_INITIAL_REMINDER_MS,
    };
  }
  if (message.authorId === ownerId) {
    return {
      ...task,
      revision: task.revision + 1,
      lastActivityAt: now,
      nextReminderAt: now + 48 * 60 * 60_000 + TASK_INITIAL_REMINDER_MS,
    };
  }
  return task;
}

export function applySourceEdit(task: TrackedTask, message: TaskReminderMessage, now = Date.parse(message.timestamp)): TrackedTask {
  if (message.id !== task.messageId || message.content === task.text || task.status !== 'open') return task;
  const candidate = task.ownership === 'assigned'
    ? detectTask(message, task.ownerId)
    : detectCommitment(message, task.ownerId);
  // Processing time resets the reminder, but must not suppress real follow-ups
  // whose Discord timestamps precede this sweep. Keep activity ordering separate.
  const lastActivityAt = Math.max(task.lastActivityAt, Date.parse(message.timestamp));
  if (!candidate) return { ...task, revision: task.revision + 1, status: 'cancelled', text: message.content, lastActivityAt };
  return {
    ...task,
    revision: task.revision + 1,
    text: message.content,
    lastActivityAt,
    nextReminderAt: now + TASK_INITIAL_REMINDER_MS,
  };
}

export function shouldSendReminder(task: TrackedTask, now: number): boolean {
  return task.status === 'open' && task.remindersSent < TASK_MAX_REMINDERS && task.nextReminderAt <= now;
}

export function advanceReminder(task: TrackedTask, now: number): TrackedTask {
  const remindersSent = task.remindersSent + 1;
  return {
    ...task,
    revision: task.revision + 1,
    remindersSent,
    lastReminderAt: now,
    nextReminderAt: now + TASK_REPEAT_REMINDER_MS,
  };
}

export function toTaskEvent(task: TrackedTask, name: TaskEventName, now: number): TaskReminderEvent {
  const eventId = `${task.id}:${name}:${task.revision}`;
  return {
    eventId,
    name,
    timestamp: new Date(now).toISOString(),
    data: {
      task_id: task.id,
      revision: task.revision,
      status: task.status,
      ownership: task.ownership,
      confidence: task.confidence,
      text: task.text,
      message_url: task.messageUrl,
      reminders_sent: task.remindersSent,
    },
    cursor: null,
  };
}

export function canTrackAnotherTask(taskCount: number): boolean {
  return taskCount < MAX_TASKS;
}

function taskFrom(message: TaskReminderMessage, ownerId: string, ownership: 'assigned' | 'commitment') {
  return {
    id: `${message.channelId}:${message.id}`,
    ownership,
    confidence: 'high' as const,
    ownerId,
    sourceAuthorId: message.authorId,
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    messageUrl: `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    text: message.content,
  };
}

export function isTaskFollowup(task: TrackedTask, message: TaskReminderMessage): boolean {
  return message.guildId === task.guildId && (message.channelId === task.channelId && message.replyToMessageId === task.messageId ||
    Boolean(task.threadId && message.channelId === task.threadId));
}

function actionableText(value: string): string | null {
  const plain = value.replace(/```[\s\S]*?```/gu, ' ').replace(/`[^`]*`/gu, ' ')
    .split('\n').filter((line) => !/^\s*>/u.test(line)).join(' ').trim();
  return plain && plain.length <= 2_000 ? plain : null;
}

function promisedDelayMs(text: string, from: number): number | null {
  const duration = text.match(/\bin\s+(\d{1,3})\s+(hour|day)s?\b/u);
  if (duration) return Number(duration[1]) * (duration[2] === 'hour' ? 60 * 60_000 : 24 * 60 * 60_000);
  if (/\btomorrow\b/u.test(text)) return 24 * 60 * 60_000;
  if (/\bnext week\b/u.test(text)) return 7 * 24 * 60 * 60_000;
  const date = text.match(/\b(?:by|due|before)\s+(\d{4}-\d{2}-\d{2})\b/u);
  if (date) {
    const dueAt = Date.parse(`${date[1]}T17:00:00.000Z`);
    if (Number.isFinite(dueAt)) return Math.max(0, dueAt - from);
  }
  const weekday = text.match(/\b(?:by|due|before)\s+(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/u);
  if (weekday) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const currentDay = new Date(from).getUTCDay();
    const targetDay = days.indexOf(weekday[1]!);
    let difference = (targetDay - currentDay + 7) % 7;
    if (difference === 0 || /\bnext\s+/u.test(weekday[0])) difference += 7;
    const due = new Date(from);
    due.setUTCDate(due.getUTCDate() + difference);
    due.setUTCHours(17, 0, 0, 0);
    return Math.max(0, due.getTime() - from);
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
