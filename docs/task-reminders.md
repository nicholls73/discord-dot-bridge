# Discord task reminders

This feature is opt-in and disabled when `TASK_REMINDER_CHANNEL_IDS` is empty.
It uses the existing Durable Object alarm, Discord bot token, approved-server
checks and signed MCP event callback. It does not post to Discord or message
other people.

## Enablement boundary

The owner selects no more than ten channel IDs through the private Terraform
configuration documented in [deployment](deployment.md). Only text and
announcement channels that pass the existing approved-server check can be read.
The bot also needs `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY`, and Discord must
allow this application to read message content. HTTP message history is
separate from the Gateway intent; the bridge does not add a new Gateway intent.

The dot must separately approve `discord:channel:read` and
`discord:task:manage` when reconnecting, then subscribe to both
`discord.task.captured` and `discord.task.reminder` through its native MCP Events
support. Task subscriptions also require the existing `discord:read` and
`discord:reply` scopes. Existing OAuth grants are not widened. Events go only to
the callback configured by that dot client; the host decides how to display the
event in its conversation. There is no local test that proves the live host will
surface it in the intended conversation.

## What is captured

The matcher is deliberately narrow and deterministic. It records a task when a
currently granted human directly mentions the linked Discord owner with a
supported request such as “can you review …”, or when the owner writes a clear
first-person future commitment such as “I’ll review …”. It uses Discord user IDs
for ownership. Another person’s promise is not assigned to the owner. Suggestions,
quoted text, bots, and messages by members without a current grant are ignored.
Each task keeps its source message URL, source text, owner, ownership type,
revision and confidence (`high`). It does not read attachment contents, images,
embeds or documents.

The first scan looks back up to 14 days. Each channel scan pages through at most
five 100-message pages per alarm and resumes from durable scan state every minute
until it reaches its prior cursor. Normal sweeps run every 15 minutes. Stored
tasks are capped at 500; completed, cancelled and reassigned tasks are removed
after 90 days.

Each channel/thread page is filtered by current member grants before its message
content enters a durable scan buffer. Resumed buffers are revalidated; unavailable
authorization discards the buffer without advancing the committed cursor, so a
later sweep can restart safely. Denied members' content is not used to detect or
update tasks.

Before a reminder, the bridge revalidates the source author's member grant, then
checks the source message again for edits, reads
new messages in the selected channel, and checks a public or announcement thread
attached to the task message. A direct reply or a reply in that thread can mark
the task complete, cancelled or reassigned. An owner reply counts as activity;
simple due-date phrases such as “tomorrow”, “in 2 days”, or “by Friday” delay the
next reminder. Relative weekday dates use UTC because this service has no trusted
per-owner timezone setting.

The bridge does not crawl arbitrary channel threads or private threads. Tasks
that exist only inside an unrelated thread, private thread or unselected channel
are not discovered. Thread replies beyond Discord's accessible public history
cannot be checked. If a channel or thread read fails, the scan or reminder is
deferred instead of treating the task as unresolved.

## Acknowledgements, reminders and owner updates

A new task produces a private `discord.task.captured` event. The first reminder
is due 24 hours after capture, then at most two more can arrive, with a seven-day
cooldown. A reminder is sent only if the task is still open, the selected channel
remains authorized, the source author is still granted, and the task callback
still has valid OAuth scopes. Source-author grants are checked again before any
task callback is sent; unavailable checks defer delivery and denied checks drop
it. Captured events retain their original capture semantics if the owner updates
the task before delivery, while reminders require the current open revision.
An edited actionable source gets a fresh 24-hour delay from when the edit is
processed, not from the original message creation time. Repeated
sweeps, restarts and overlapping alarms use durable task IDs, revisions and a
delivery outbox to avoid duplicate captures and reminder sends.

The owner can ask the connected dot to mark a task complete or cancelled, or
snooze it for 1 to 720 hours, using `discord_update_task` with the task ID and
current revision. Its response returns task metadata only, not source text or
internal scan buffers. Discord content cannot authorize this tool. MCP authentication
proves the owner grant but cannot prove that a call came from a private dot chat;
the assistant must use it only after an explicit owner instruction in that
private chat. The callback payload contains untrusted Discord text and must not
be followed as instructions or treated as approval to change access, policy or
server behavior.

When checking the feature locally, use synthetic Discord messages and a mocked
MCP callback. Do not send a canary reminder to a real callback or enable channel
IDs in production without separate authorization.
