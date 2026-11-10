import { describe, expect, it, vi } from 'vitest';
import { DiscordRestMessenger } from '../src/discord.js';
import { BridgeStateDO } from '../src/bridge-state.js';
import {
  TASK_CAPTURED_EVENT_NAME,
  TASK_REMINDER_EVENT_NAME,
  toTaskEvent,
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


// Exercise the persistence and callback boundaries, not just task detection.
describe('task reminder authorization boundaries', () => {
  function fixture() {
    const storage = new MemoryStorage();
    const callback = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    const bridge = new BridgeStateDO({ storage, waitUntil: () => undefined } as never, {
      ACCESS_OWNER_EMAIL: 'owner@example.test', TASK_REMINDER_CHANNEL_IDS: channelId,
      DISCORD_BOT_USER_ID: '99999999999999999', DISCORD_BOT_TOKEN: 'synthetic-token',
    }, { now: () => time + TASK_INITIAL_REMINDER_MS, fetch: callback });
    // Private workflow entrypoints allow deterministic pagination/auth failure injection.
    const internal = bridge as any;
    internal.scheduleNextWake = vi.fn(async () => undefined);
    internal.isChannelAuthorized = vi.fn(async () => true);
    internal.isAuthorizedMember = vi.fn(async () => ({ status: 'authorized' }));
    internal.isSubscriptionAuthorized = vi.fn(async () => true);
    internal.getLinkedDiscordAccount = vi.fn(async () => ({ userId: ownerId }));
    const subscription = {
      id: 'synthetic-task-sub', principal: 'owner@example.test', name: TASK_REMINDER_EVENT_NAME,
      url: 'https://receiver.example.com/callback',
      secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
      refreshBefore: '2027-01-01T00:00:00.000Z', arguments: {},
    };
    return { storage, bridge, internal, callback, subscription };
  }

  it('deduplicates page authors with bounded parallel checks and preserves message order', async () => {
    const { internal } = fixture();
    let active = 0;
    let maxActive = 0;
    internal.isAuthorizedMember.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { status: 'authorized' };
    });
    const messages = Array.from({ length: 12 }, (_, index) => message({ authorId: String(BigInt(authorId) + BigInt(index % 6)) }));
    expect(await internal.authorizedTaskMessages(messages)).toEqual(messages);
    expect(internal.isAuthorizedMember).toHaveBeenCalledTimes(6);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it.each(['channel', 'thread'])('filters each %s page before durable buffering', async (kind) => {
    const { storage, internal } = fixture();
    internal.isAuthorizedMember.mockImplementation(async (_guild: string, author: string) => ({
      status: author === authorId ? 'denied' : 'authorized',
    }));
    let page = 0;
    const messenger = { listChannelMessages: vi.fn(async () => {
      const id = String(BigInt(sourceId) + 1000n - BigInt(++page * 10));
      return { guildId, messages: [message({ id, content: 'UNGRANTED-CONTENT' }),
        message({ id: String(BigInt(id) - 1n), authorId: ownerId, content: 'Allowed content' })], nextBefore: id };
    }) };
    if (kind === 'channel') {
      expect(await internal.scanTaskChannel(channelId, ownerId, 'owner@example.test', messenger, [])).toBe(false);
    } else {
      const tracked = task({ threadId: '77777777777777777', threadCursor: sourceId });
      await storage.put(taskKey(tracked.id), tracked);
      expect(await internal.checkTaskThread(tracked, taskKey(tracked.id), ownerId, 'owner@example.test', messenger, async () => true)).toBe(false);
    }
    expect(messenger.listChannelMessages).toHaveBeenCalledTimes(5);
    expect(JSON.stringify([...storage.values])).not.toContain('UNGRANTED-CONTENT');
    expect(JSON.stringify([...storage.values])).toContain('Allowed content');
  });

  it.each(['channel', 'thread'])('does not persist a %s page or advance its cursor when member checks are unavailable', async (kind) => {
    const { storage, internal } = fixture();
    internal.isAuthorizedMember.mockResolvedValue({ status: 'unavailable' });
    const messenger = { listChannelMessages: vi.fn(async () => ({
      guildId, messages: [message({ id: String(BigInt(sourceId) + 1n), content: 'UNVERIFIED-CONTENT' })], nextBefore: sourceId,
    })) };
    if (kind === 'channel') {
      await expect(internal.scanTaskChannel(channelId, ownerId, 'owner@example.test', messenger, [])).rejects.toThrow('authorization');
      expect(await storage.get(`task-reminders:cursor:${channelId}`)).toBeUndefined();
    } else {
      const tracked = task({ threadId: '77777777777777777', threadCursor: sourceId });
      await storage.put(taskKey(tracked.id), tracked);
      await expect(internal.checkTaskThread(tracked, taskKey(tracked.id), ownerId, 'owner@example.test', messenger, async () => true)).rejects.toThrow('authorization');
      expect(await storage.get(taskKey(tracked.id))).toMatchObject({ threadCursor: sourceId });
    }
    expect(JSON.stringify([...storage.values])).not.toContain('UNVERIFIED-CONTENT');
  });

  it.each(['channel', 'thread'])('revalidates a resumed %s buffer and drops revoked content', async (kind) => {
    const { storage, internal } = fixture();
    internal.isAuthorizedMember.mockResolvedValue({ status: 'denied' });
    const buffered = { before: sourceId, highWaterId: String(BigInt(sourceId) + 1n), messages: [message({ content: 'REVOKED-BUFFER' })] };
    const messenger = { listChannelMessages: vi.fn(async () => ({ guildId, messages: [], nextBefore: null })) };
    if (kind === 'channel') {
      await storage.put(`task-reminders:scan:${channelId}`, { ...buffered, cursor: null, cutoffAt: time - 1 });
      await internal.scanTaskChannel(channelId, ownerId, 'owner@example.test', messenger, []);
      expect((await storage.list({ prefix: 'task:' })).size).toBe(0);
    } else {
      const tracked = task({ threadId: '77777777777777777', threadScan: buffered });
      await storage.put(taskKey(tracked.id), tracked);
      await internal.checkTaskThread(tracked, taskKey(tracked.id), ownerId, 'owner@example.test', messenger, async () => true);
      expect((await storage.get<TrackedTask>(taskKey(tracked.id)))?.threadScan).toBeUndefined();
    }
    expect(JSON.stringify([...storage.values])).not.toContain('REVOKED-BUFFER');
  });

  it.each(['channel', 'thread'])('discards a resumed %s buffer if authorization is unavailable without committing the cursor', async (kind) => {
    const { storage, internal } = fixture();
    internal.isAuthorizedMember.mockResolvedValue({ status: 'unavailable' });
    const buffered = { before: sourceId, highWaterId: String(BigInt(sourceId) + 1n), messages: [message({ content: 'UNVERIFIED-BUFFER' })] };
    const messenger = { listChannelMessages: vi.fn() };
    if (kind === 'channel') {
      await storage.put(`task-reminders:scan:${channelId}`, { ...buffered, cursor: sourceId, cutoffAt: time - 1 });
      await storage.put(`task-reminders:cursor:${channelId}`, sourceId);
      await expect(internal.scanTaskChannel(channelId, ownerId, 'owner@example.test', messenger, [])).rejects.toThrow('authorization');
      expect(await storage.get(`task-reminders:cursor:${channelId}`)).toBe(sourceId);
    } else {
      const tracked = task({ threadId: '77777777777777777', threadCursor: sourceId, threadScan: buffered });
      await storage.put(taskKey(tracked.id), tracked);
      await expect(internal.checkTaskThread(tracked, taskKey(tracked.id), ownerId, 'owner@example.test', messenger, async () => true)).rejects.toThrow('authorization');
      expect(await storage.get(taskKey(tracked.id))).toMatchObject({ threadCursor: sourceId });
    }
    expect(messenger.listChannelMessages).not.toHaveBeenCalled();
    expect(JSON.stringify([...storage.values])).not.toContain('UNVERIFIED-BUFFER');
  });

  it.each(['denied', 'unavailable'])('does not fetch a due source when author access is %s', async (status) => {
    const { storage, internal, subscription } = fixture();
    await storage.put(taskKey(task().id), task());
    internal.isAuthorizedMember.mockResolvedValue({ status });
    const fetchSource = vi.spyOn(DiscordRestMessenger.prototype, 'getChannelMessage');
    try {
      await internal.queueDueTaskReminders([subscription]);
      expect(fetchSource).not.toHaveBeenCalled();
      expect((await storage.list({ prefix: 'delivery:' })).size).toBe(0);
    } finally { fetchSource.mockRestore(); }
  });

  it.each([TASK_CAPTURED_EVENT_NAME, TASK_REMINDER_EVENT_NAME])('rechecks source grants before delivering %s', async (name) => {
    const { storage, internal, subscription, callback } = fixture();
    const tracked = task();
    await storage.put(taskKey(tracked.id), tracked);
    await storage.put(`subscription:${subscription.id}`, { ...subscription, name });
    const delivery = { subscriptionId: subscription.id, event: toTaskEvent(tracked, name, time), attempts: 0, nextAttemptAt: time };
    await storage.put('delivery:pending', delivery);
    internal.isAuthorizedMember.mockResolvedValue({ status: 'unavailable' });
    await internal.processDueDeliveries();
    expect(callback).not.toHaveBeenCalled();
    expect(await storage.get('delivery:pending')).toMatchObject({ attempts: 1 });
    await storage.put('delivery:pending', delivery);
    internal.isAuthorizedMember.mockResolvedValue({ status: 'denied' });
    await internal.processDueDeliveries();
    expect(callback).not.toHaveBeenCalled();
    expect(await storage.get('delivery:pending')).toBeUndefined();
  });

  it('keeps a captured event after a normal owner acknowledgement, but drops stale reminders', async () => {
    const { storage, internal, subscription, callback } = fixture();
    const tracked = task();
    await storage.put(taskKey(tracked.id), tracked);
    for (const name of [TASK_CAPTURED_EVENT_NAME, TASK_REMINDER_EVENT_NAME]) {
      await storage.put(`subscription:${name}`, { ...subscription, id: name, name });
      await storage.put(`delivery:${name}`, { subscriptionId: name, event: toTaskEvent(tracked, name, time), attempts: 0, nextAttemptAt: time });
    }
    await internal.updateTask('owner@example.test', tracked.id, 1, 'complete');
    expect((await storage.list({ prefix: 'delivery:' })).size).toBe(1);
    await internal.processDueDeliveries();
    expect(callback).toHaveBeenCalledOnce();
    expect(JSON.parse(String(callback.mock.calls[0]![1]?.body)).name).toBe(TASK_CAPTURED_EVENT_NAME);
  });

  it.each(['member', 'channel'])('drops a reminder completed during the %s authorization await', async (stage) => {
    const { storage, internal, subscription, callback } = fixture();
    const tracked = task();
    await storage.put(taskKey(tracked.id), tracked);
    await storage.put(`subscription:${subscription.id}`, subscription);
    await storage.put('delivery:race', { subscriptionId: subscription.id,
      event: toTaskEvent(tracked, TASK_REMINDER_EVENT_NAME, time), attempts: 0, nextAttemptAt: time });
    const complete = async () => { await internal.updateTask('owner@example.test', tracked.id, 1, 'complete'); };
    if (stage === 'member') internal.isAuthorizedMember.mockImplementation(async () => { await complete(); return { status: 'authorized' }; });
    else internal.isChannelAuthorized.mockImplementation(async () => { await complete(); return true; });
    await internal.processDueDeliveries();
    expect(callback).not.toHaveBeenCalled();
    expect(await storage.get('delivery:race')).toBeUndefined();
  });

  it('does not recreate a reminder cancelled during an unavailable authorization check', async () => {
    const { storage, internal, subscription, callback } = fixture();
    const tracked = task();
    await storage.put(taskKey(tracked.id), tracked);
    await storage.put(`subscription:${subscription.id}`, subscription);
    await storage.put('delivery:race', { subscriptionId: subscription.id,
      event: toTaskEvent(tracked, TASK_REMINDER_EVENT_NAME, time), attempts: 0, nextAttemptAt: time });
    internal.isAuthorizedMember.mockImplementation(async () => {
      await internal.updateTask('owner@example.test', tracked.id, 1, 'cancel');
      return { status: 'unavailable' };
    });
    await internal.processDueDeliveries();
    expect(callback).not.toHaveBeenCalled();
    expect(await storage.get('delivery:race')).toBeUndefined();
  });

  it('does not immediately retry a failed event from a concurrent delivery snapshot', async () => {
    const { storage, internal, subscription, callback } = fixture();
    const tracked = task();
    await storage.put(taskKey(tracked.id), tracked);
    await storage.put(`subscription:${subscription.id}`, subscription);
    await storage.put('delivery:race', { subscriptionId: subscription.id,
      event: toTaskEvent(tracked, TASK_REMINDER_EVENT_NAME, time), attempts: 0, nextAttemptAt: time });
    callback.mockResolvedValue(new Response(null, { status: 503 }));
    await Promise.all([internal.processDueDeliveries(), internal.processDueDeliveries()]);
    expect(callback).toHaveBeenCalledOnce();
    expect(await storage.get('delivery:race')).toMatchObject({ attempts: 1 });
  });

  it('orders an owner update after an already-started send, without resurrecting a failed reminder', async () => {
    const { storage, internal, subscription, callback } = fixture();
    const tracked = task();
    await storage.put(taskKey(tracked.id), tracked);
    await storage.put(`subscription:${subscription.id}`, subscription);
    await storage.put('delivery:race', { subscriptionId: subscription.id,
      event: toTaskEvent(tracked, TASK_REMINDER_EVENT_NAME, time), attempts: 0, nextAttemptAt: time });
    let update: Promise<unknown> | undefined;
    callback.mockImplementation(async () => {
      update = internal.updateTask('owner@example.test', tracked.id, 1, 'cancel');
      return new Response(null, { status: 503 });
    });
    await internal.processDueDeliveries();
    await update;
    expect(callback).toHaveBeenCalledOnce();
    expect(await storage.get('delivery:race')).toBeUndefined();
    expect(await storage.get(taskKey(tracked.id))).toMatchObject({ status: 'cancelled' });
  });

  it('returns only task metadata from owner updates, never source text or scan buffers', async () => {
    const { storage, internal } = fixture();
    const tracked = task({ threadScan: { before: sourceId, highWaterId: sourceId, messages: [message({ content: 'BUFFER-PRIVATE' })] } });
    await storage.put(taskKey(tracked.id), tracked);
    internal.isAuthorizedMember.mockResolvedValue({ status: 'denied' });
    const result = await internal.updateTask('owner@example.test', tracked.id, 1, 'cancel');
    expect(result).toEqual({ ok: true, task: {
      id: tracked.id, revision: 2, status: 'cancelled', nextReminderAt: tracked.nextReminderAt,
    } });
    expect(JSON.stringify(result)).not.toContain(tracked.text);
    expect(JSON.stringify(result)).not.toContain('BUFFER-PRIVATE');
  });

  it('does not suppress a completion after an edited source in the same delayed sweep', async () => {
    const { storage, internal } = fixture();
    const tracked = task();
    await storage.put(taskKey(tracked.id), tracked);
    await internal.processTaskMessages([
      message({ content: `<@${ownerId}> can you review the revised HTML?` }),
      message({ id: String(BigInt(sourceId) + 1n), authorId: ownerId, content: 'Done, reviewed.',
        replyToMessageId: sourceId, timestamp: new Date(time + 1000).toISOString() }),
    ], ownerId, []);
    expect(await storage.get(taskKey(tracked.id))).toMatchObject({ status: 'completed' });
  });

  it('delays an edited source from the processing time, not its original timestamp', () => {
    const now = time + 3 * TASK_INITIAL_REMINDER_MS;
    const updated = applySourceEdit(task(), message({ content: `<@${ownerId}> can you review the revised HTML?` }), now);
    expect(updated.nextReminderAt).toBe(now + TASK_INITIAL_REMINDER_MS);
    expect(updated.lastActivityAt).toBe(time);
    expect(shouldSendReminder(updated, now)).toBe(false);
  });
});
