import { describe, expect, it } from 'vitest';
import { BridgeStateDO } from '../src/bridge-state.js';
import {
  TASK_INITIAL_REMINDER_MS,
  TASK_MAX_REMINDERS,
  TASK_REPEAT_REMINDER_MS,
  advanceReminder,
  applySourceEdit,
  applyTaskFollowup,
  detectTaskCandidate,
  parseTaskReminderChannelIds,
  shouldSendReminder,
  taskKey,
  type TaskReminderMessage,
  type TrackedTask,
} from '../src/task-reminders.js';

const ownerId = '22222222222222222';
const authorId = '33333333333333333';
const guildId = '11111111111111111';
const channelId = '55555555555555555';
const sourceId = '66666666666666666';
const time = Date.parse('2026-11-09T12:00:00.000Z');

function message(overrides: Partial<TaskReminderMessage> = {}): TaskReminderMessage {
  return {
    id: sourceId,
    channelId,
    guildId,
    authorId,
    authorDisplayName: 'Synthetic colleague',
    authorIsBot: false,
    content: `<@${ownerId}> can you review the HTML before deployment?`,
    mentionedUserIds: [ownerId],
    timestamp: new Date(time).toISOString(),
    ...overrides,
  };
}

function task(overrides: Partial<TrackedTask> = {}): TrackedTask {
  const candidate = detectTaskCandidate(message(), ownerId)!;
  return {
    ...candidate,
    revision: 1,
    status: 'open',
    createdAt: time,
    lastActivityAt: time,
    nextReminderAt: time + TASK_INITIAL_REMINDER_MS,
    remindersSent: 0,
    ...overrides,
  };
}

describe('task reminder detection and lifecycle', () => {
  it('captures a direct assignment to the linked owner and the owner’s own commitment', () => {
    expect(detectTaskCandidate(message(), ownerId)).toMatchObject({ ownership: 'assigned', ownerId });
    expect(detectTaskCandidate(message({
      id: '66666666666666667', authorId: ownerId, mentionedUserIds: [],
      content: 'I’ll review the HTML before deployment.',
    }), ownerId)).toMatchObject({ ownership: 'commitment', ownerId, sourceAuthorId: ownerId });
  });

  it('does not assign another person’s promise to Alex or turn discussion into a task', () => {
    expect(detectTaskCandidate(message({ authorId: '44444444444444444', content: 'I will CC the client.' }), ownerId)).toBeNull();
    expect(detectTaskCandidate(message({ content: 'Maybe Alex should review the HTML.' , mentionedUserIds: [] }), ownerId)).toBeNull();
    expect(detectTaskCandidate(message({ content: '> I’ll review the HTML.\nWe should consider that.' , authorId: ownerId, mentionedUserIds: [] }), ownerId)).toBeNull();
    expect(detectTaskCandidate(message({ authorIsBot: true }), ownerId)).toBeNull();
  });

  it('links follow-ups in the task’s public thread and resolves completed, cancelled, or reassigned work', () => {
    const threadTask = task({ threadId: '77777777777777777', threadCursor: sourceId });
    const done = applyTaskFollowup(threadTask, message({
      id: '77777777777777778', channelId: threadTask.threadId!, authorId: ownerId,
      content: 'Done, reviewed and sent.', mentionedUserIds: [],
      timestamp: '2026-11-10T12:00:00.000Z',
    }), ownerId);
    expect(done.status).toBe('completed');
    expect(applyTaskFollowup(threadTask, message({
      id: '66666666666666667', authorId, content: 'Cancelled, no longer needed.',
      replyToMessageId: sourceId, mentionedUserIds: [], timestamp: '2026-11-10T12:00:00.000Z',
    }), ownerId).status).toBe('cancelled');
    expect(applyTaskFollowup(threadTask, message({
      id: '66666666666666668', authorId, content: 'Morgan will handle this instead.',
      replyToMessageId: sourceId, mentionedUserIds: [], timestamp: '2026-11-10T12:00:00.000Z',
    }), ownerId).status).toBe('reassigned');
  });

  it('treats a direct answer or changed due date as activity and delays the reminder', () => {
    const answer = applyTaskFollowup(task(), message({
      id: '66666666666666667', channelId, authorId: ownerId,
      content: 'I’ll review this by Friday.', replyToMessageId: sourceId,
      mentionedUserIds: [], timestamp: '2026-11-09T12:01:00.000Z',
    }), ownerId);
    expect(answer.status).toBe('open');
    expect(answer.nextReminderAt).toBeGreaterThan(Date.parse('2026-11-14T00:00:00.000Z'));
  });

  it('uses the current source text and cancels when an edit removes the actionable request', () => {
    const original = task();
    expect(applySourceEdit(original, message()).revision).toBe(original.revision);
    const edited = applySourceEdit(original, message({
      content: 'Maybe Alex could review this sometime.', mentionedUserIds: [],
      timestamp: '2026-11-09T13:00:00.000Z',
    }));
    expect(edited).toMatchObject({ status: 'cancelled', text: 'Maybe Alex could review this sometime.' });
  });

  it('limits reminders and observes a seven-day cooldown across repeated sweeps', () => {
    let current = task();
    const firstDue = current.nextReminderAt;
    expect(shouldSendReminder(current, firstDue)).toBe(true);
    current = advanceReminder(current, firstDue);
    expect(shouldSendReminder(current, firstDue + TASK_REPEAT_REMINDER_MS - 1)).toBe(false);
    for (let count = 1; count < TASK_MAX_REMINDERS; count += 1) {
      current = advanceReminder(current, current.nextReminderAt);
    }
    expect(shouldSendReminder(current, current.nextReminderAt + TASK_REPEAT_REMINDER_MS)).toBe(false);
  });

  it('validates a bounded, explicit channel allowlist', () => {
    expect(parseTaskReminderChannelIds(undefined)).toEqual([]);
    expect(parseTaskReminderChannelIds(`${channelId},77777777777777777`)).toEqual([channelId, '77777777777777777']);
    expect(() => parseTaskReminderChannelIds(`${channelId},${channelId}`)).toThrow();
    expect(() => parseTaskReminderChannelIds('general')).toThrow();
  });

  it('uses a stable task key and does not enqueue duplicate captures on repeated sweeps', async () => {
    const storage = new MemoryStorage();
    const bridge = new BridgeStateDO({ storage, waitUntil: () => undefined } as never, {
      ACCESS_OWNER_EMAIL: 'owner@example.test',
    }, { now: () => time });
    const candidate = message();
    const process = (bridge as unknown as {
      processTaskMessages(messages: TaskReminderMessage[], owner: string, subscriptions: never[]): Promise<void>;
    }).processTaskMessages.bind(bridge);
    await process([candidate], ownerId, []);
    await process([candidate], ownerId, []);
    const stored = await storage.list<TrackedTask>({ prefix: 'task:' });
    expect([...stored.keys()]).toEqual([taskKey(`${channelId}:${sourceId}`)]);
    expect(stored.size).toBe(1);
  });

  it('does not capture an owner acknowledgment as a second commitment task', async () => {
    const storage = new MemoryStorage();
    const bridge = new BridgeStateDO({ storage, waitUntil: () => undefined } as never, {
      ACCESS_OWNER_EMAIL: 'owner@example.test',
    }, { now: () => time });
    const process = (bridge as unknown as {
      processTaskMessages(messages: TaskReminderMessage[], owner: string, subscriptions: never[]): Promise<void>;
    }).processTaskMessages.bind(bridge);
    await process([
      message(),
      message({
        id: '66666666666666667', authorId: ownerId, mentionedUserIds: [],
        replyToMessageId: sourceId, content: 'I’ll review the HTML before deployment.',
        timestamp: '2026-11-09T12:01:00.000Z',
      }),
    ], ownerId, []);
    const stored = await storage.list<TrackedTask>({ prefix: 'task:' });
    expect(stored.size).toBe(1);
    expect([...stored.values()][0]).toMatchObject({ ownership: 'assigned', lastActivityAt: Date.parse('2026-11-09T12:01:00.000Z') });
  });
});

class MemoryStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async list<T>({ prefix = '' }: { prefix?: string } = {}): Promise<Map<string, T>> {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)) as [string, T][]);
  }
  async transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> { return callback(this); }
  async getAlarm(): Promise<number | null> { return null; }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}
