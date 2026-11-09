# Discord Gateway and MCP Events setup

After completing the [deployment guide](deployment.md), configure Discord permissions, connect your dot and test the integration with synthetic messages. Local tests do not establish live host compatibility.

## Discord permissions

1. Install your own Discord bot only into servers you intend to approve. Give it access only to channels where approved members may mention it. Mention replies need `VIEW_CHANNEL` and `SEND_MESSAGES`; replies inside threads use `SEND_MESSAGES_IN_THREADS`. Message lookups also need `READ_MESSAGE_HISTORY`; standalone sends need `SEND_MESSAGES` in channels or `SEND_MESSAGES_IN_THREADS` in threads plus history access. Own-message edits remain limited to channels and need channel permissions and history access. The admin invite link requests these permissions, but channel-specific overwrites can still deny them.
2. The Gateway requests only `GUILD_MESSAGES`. Direct bot mentions include content without the privileged `MESSAGE_CONTENT` intent, so direct mention handling does not require that intent. HTTP reads of other message content require Message Content access for the Discord application in the Developer Portal. This changes no Gateway identify intent. Unmentioned traffic triggers only [verified conversation follow-ups](#follow-ups-without-another-mention). The Worker discovers the Gateway URL with `GET /api/v10/gateway/bot`, then saves `READY.resume_gateway_url` and the latest dispatch sequence for session resume. See [Discord Message Content intent](https://docs.discord.com/developers/events/gateway#message-content-intent) and the [Message resource](https://docs.discord.com/developers/resources/message).
3. Configure credentials through the [deployment guide](deployment.md). Server, user and role grants are managed at runtime, not through deployment variables.

## Connect the dot

Add an OAuth MCP connection in your dot host using `https://discord-dot.<workers_dev_subdomain>.workers.dev/mcp`. Sign in through the owner Access gate and approve `discord:read` and `discord:reply`. Configure the [listener guidance](response-policy.md#listener-setup) on that same dot, and use the host's native MCP Events support to subscribe to `discord.message.mentioned`. The [canary](#canary-sequence) verifies that the subscription wakes the intended dot and its reply reaches Discord. A host without MCP Events support cannot receive mention wakes from this bridge.

Only request `discord:channel:read`, `discord:message:send`, `discord:message:edit` or `discord:task:manage` when needed. Each scope is separately shown on consent and starts unchecked. Task events and their extra authorization are described in [task reminders](task-reminders.md). Other connectors are optional and are not configured by this project.

Terraform creates separate owner-only Cloudflare Access applications for `/admin` and `/authorize`, restricted to the configured identity provider and owner email. The Worker checks the corresponding audience for each route. Server/member grant administration remains owner-authenticated and is not an MCP tool.

Existing MCP connections do not gain new scopes automatically. Reconnect and explicitly approve `discord:reply` before subscribing if needed. On the consent screen, the owner can also select any optional channel scope even when the client requested only the core scopes. These choices are unchecked by default, and only selected scopes are granted. The channel tools are listed for the authenticated owner before their optional scopes are granted; calling one without its scope returns an OAuth `insufficient_scope` challenge before Discord or storage access. The [MCP step-up flow](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#scope-challenge-handling) says user-facing clients should attempt reauthorization for the added scope. If the connected host does not start that flow, reconnect through its normal UI and select the scope on consent. Confirm that only intended scopes were granted.

Subscriptions expire after at most 24 hours and are capped at the OAuth token expiry. The client must refresh before `refreshBefore`. If Discord closes the Gateway with `4014`, correct the bot's intent configuration, then refresh its existing authorised subscription. A refresh clears the terminal-stop marker; deployment alone does not. Verify **Ready** in admin and a same-channel reply. Avoid duplicate subscriptions or polling automations.

## Runtime approval and revocation

The authorization store starts empty. Installing the bot or creating an MCP Events subscription does not approve a server or member.

1. After the production apply and owner OAuth setup succeed, open `https://discord-dot.<workers_dev_subdomain>.workers.dev/admin` and sign in with the owner account through the selected existing identity provider.
2. Link the owner's Discord account, choose a server returned by Discord where that account is the owner or has `MANAGE_GUILD`/`ADMINISTRATOR`, and grant the linked account or load that server's current roles and explicitly grant one. A role grant also approves the selected server. The server list expires after five minutes. The Durable Object verifies bot membership before loading roles and again before saving a grant.
3. `@everyone` is excluded because it would authorize every server member. A role grant authorizes members Discord currently reports with that role in the approved server. It does not add or change the role in Discord. A role ID from another server does not grant access. Each list is bounded to 50 servers and 100 users and 100 roles per server. Role lookups use the bot's read-only REST access; the flow adds no `MANAGE_ROLES` requirement or member-list intent.
4. Revoke a server, user, or role grant on the same page. Changes are saved in `BridgeStateDO` storage and take effect without editing GitHub variables or redeploying. If a user still matches another grant in that server, that grant continues to allow them.

For each mention, stored-origin read, queued event delivery, and reply, the Worker checks current membership using Discord's single-member endpoint and applies the saved grants. It does not trust role IDs included in a message payload. If Discord cannot confirm membership, that operation fails closed; queued callbacks use the existing bounded retry policy. Revoked or expired origins cannot be read or replied to. The reply destination still comes only from the validated origin, so the dot cannot select another server, channel, or message. See [Discord Get Guild Member](https://discord.com/developers/docs/resources/guild#get-guild-member).

The owner controls page is not available through Discord messages or MCP tools. Discord content is untrusted input and cannot change access grants. The MCP server exposes origin-read, origin-reply, pending-mention recovery, and current-policy read tools. Optional policy management is separately consented; see [policy management and its private-chat boundary](response-policy.md). Ordinary mention grants cannot mutate policy.

## Optional channel reads and standalone messages

The optional `discord:channel:read` scope exposes `discord_list_channels` and `discord_list_channel_messages`. `discord_list_channels` accepts only `{ "guildId": "<17–20 digit snowflake>" }` and returns `{ "guildId": "…", "channels": [{ "id": "…", "name": "…", "type": 0, "parentId": null }] }`. It lists guild channels returned by Discord, not DMs or threads, and returns only IDs, names, numeric channel types, and parent IDs; channel names are untrusted data. The tool is available to the authenticated owner with `discord:read`, and each call also requires explicit `discord:channel:read` consent. The linked Discord owner must be a current member of the approved server with an existing user or role grant. Server authorization is checked before and after the Discord request; a denied or unavailable check returns no channel list.

`discord_list_channel_messages` accepts exactly one of `channelId` or `threadId`, an optional `before` snowflake, and a limit from 1 to 20. It supports guild text and announcement channels plus explicitly named public and announcement threads whose parent is a supported text or announcement channel. The server verifies the exact destination ID, thread type, and same-server parent; DMs and private threads are not supported. The linked Discord owner must be a current member of an approved server with an existing user or role grant. Each page returns the bot's own messages plus messages by current human members who also have a user or role grant; other bots and unauthorized members are omitted. The tool rechecks server authorization before returning the page. If a member or grant check is unavailable, the whole page fails without returning its cursor; retry the same page so an outage cannot silently skip authorized messages. Continue from `nextBefore`, including when a page contains no visible messages.

The optional `discord:message:send` scope exposes `discord_send_message`; `discord:message:edit` separately exposes `discord_edit_own_message`. Send with exactly one of `channelId` or `threadId`; for a thread, the server verifies the exact target ID and its supported parent before posting to that thread. Private and locked threads are rejected. Permission checks use the parent channel's overwrites and require `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`, and `SEND_MESSAGES_IN_THREADS`; Discord documents that thread permissions inherit from the parent except for `SEND_MESSAGES` ([permissions](https://docs.discord.com/developers/topics/permissions)). Discord's [Create Message API](https://docs.discord.com/developers/resources/channel#create-message) automatically unarchives an unlocked archived thread when it accepts a message. The send requires a stable caller-provided `idempotencyKey`; the Worker reserves it before the Discord request and uses Discord's enforced nonce to reconcile an uncertain result. A retry searches only the newest 100 destination messages. If the nonce is not found, the tool returns an unresolved `message_started` result that reports the scan limit and whether older history may contain the message; this does not prove the send failed. The bot never posts a second message for that reservation. Inspect the channel or thread before creating any new send. The edit tool fetches the target and checks that Discord reports this bot as its author before patching. There is no delete tool.

Both writing tools accept optional `mentionUserIds` with explicit current authorized human member IDs. When omitted or empty, all mentions are disabled; the adapter never enables role or everyone mentions. If the message text contains other mention syntax, Discord does not notify those users. Recheck the bot's permissions and channel overwrites if a tool reports a permission failure. The OAuth scopes do not grant Discord permissions by themselves; the bot's server install and channel configuration remain separate.

The dot does not start the Gateway connection until an MCP Events subscription exists. One `BridgeStateDO` owns the persistent WebSocket, heartbeat alarms, resume state, accepted origin messages, and durable callback outbox. A subscription is capped at the OAuth token expiry and is removed when that OAuth token record is revoked. Stored origins expire after seven days.

## Bot account and bot role mentions

Discord's mention picker can show both the bot account and a role with the same
name. Direct bot-account mentions work in normal messages and replies to another
person. The bot's own managed role also triggers a mention, but only after the
bridge checks the sender's existing server/member access and verifies Discord's
`managed` and `tags.bot_id` role metadata. Other roles, namesakes and `@everyone`
do not trigger it.

Role mentions may arrive without Gateway content. Only when that content is
empty does the bridge retrieve the incoming message through REST, check its ID,
channel, author, timestamp and role mention, and retain it as the reply
destination. Quoted mentions cannot enable the trigger; [conversation context](#conversation-context)
is read separately when authorised.
This fallback requires the application's
existing Message Content access and the bot's `VIEW_CHANNEL` and
`READ_MESSAGE_HISTORY` permissions. It does not enable an intent or change any
permissions. If REST content is unavailable, use the bot-account mention;
the bridge fails closed instead of delivering a blank role mention.

## Follow-ups without another mention

When a reply asks a question or otherwise invites an answer, the dot should set
`expectsResponse` on `discord_reply_to_origin`. Older clients can omit the flag:
the server infers an unquoted question or direct invitation from the reply text.
This is a conservative text heuristic; the optional flag explicitly overrides
it for ambiguous replies. Only a confirmed send opens a
short-lived wait for one plain answer from the same member in the same server
and text or announcement channel. The next accepted answer consumes that wait;
a subsequent question must open another one. Waits survive Worker restarts, but
expired waits and uncertain sends cannot enable this trigger. The
[bridge implementation](../src/bridge-state.ts) owns the expiry and validation.

The bridge verifies the incoming answer and the bot's question through REST,
then returns the question as `awaitedReply` context. Messages directed to
someone else through Reply or a mention do not count as plain answers. This
uses the application's existing Message Content access and server/member grants;
it changes no Gateway intent or OAuth scope. Without readable REST content,
use a direct bot-account mention. This question/answer state is separate from
the [owner-managed response policy](response-policy.md).

Approved members can continue a public or announcement thread started from the
bot's own message without repeating its mention. The bridge verifies the
thread's server and parent channel, then reads the starter message from that
parent and checks that this bot authored it. Discord assigns the thread the
same ID as its source message; a thread name, quoted mention, or caller-supplied
context cannot enable this trigger. See [Discord threads](https://docs.discord.com/developers/topics/threads).

When Gateway content is empty, the bridge reads only the incoming thread
message through REST and verifies its identity, author and timestamp. This uses
the application's existing Message Content access; no Gateway intent or live
permission is changed. Missing, denied or empty content produces no wake. Use a
direct bot-account mention when that access is unavailable.

These follow-ups use the existing `discord.message.mentioned` subscription,
typing, recovery and once-only reply flow. The origin read includes the bot's
starter text as untrusted context, and the reply targets the incoming message
inside the thread. Current server/member grants are checked before content
lookups, again before acceptance, and during delivery, reads and replies.
Discord's Reply action on a bot-authored message also triggers a response without
a ping, including outside those threads. The bridge verifies the channel's
server, the incoming message's actual reply reference, and the target bot author
through REST. A forwarded message or a reply to another person does not enable
this trigger. The origin includes that bot message as `botReply` context.

Outside an active wait, plain messages in ordinary channels still require an
explicit mention or Reply to the bot. Threads rooted in someone else's message
and private threads also require an explicit mention or Reply to the bot.
Private threads also require Discord to give the bot access to that thread.

## Conversation context

With existing, separately consented `discord:channel:read` access,
`discord_get_origin_message` automatically includes a bounded recent conversation
and reply chain. In a public or announcement thread it also follows the starter
back into the parent channel, so a follow-up can refer to the original request.
The [tool implementation](../src/mcp.ts) owns the bounds and result fields. The
standalone history tool's supported channel types are unchanged.

The origin read also identifies the actual immediately preceding message and
its permalink when that message is authorized. This lets the dot resolve
"the above message" directly. If that message is hidden, an older visible
message is never presented as the immediate predecessor.

Context reads require current linked-owner access to the approved server and
the bot's view/history permissions. They return only this bot's messages and
messages by currently granted human members. Cross-channel reply references,
forwarded content, DMs and private-thread history are excluded. Context is fetched
on demand, not stored with the origin or included in event notifications.

Without that optional scope the origin remains readable and reports
`requires_channel_read_scope`; existing grants are never widened. Failed context
or membership checks return `unavailable` without context text. Deleted messages
and bounded history can produce incomplete context. Empty text alone cannot
distinguish an attachment-only message from unavailable Message Content access.
Use the supplied context before asking someone to repeat their request, and
state any relevant gap rather than guessing.

## Native typing while the dot handles a mention

An accepted mention or bot-thread follow-up starts the bot's native Discord typing indicator promptly, after the bridge verifies a live authorized subscription that received that message and the sender's current access. It uses the existing bot token and the same dot's event/reply flow. It creates no thinking messages, new tools, subscriptions, AI runtime, or credentials. Messages without an eligible recipient do not trigger typing; historical origins are not backfilled.

Discord's [typing endpoint](https://docs.discord.com/developers/resources/channel#trigger-typing-indicator) expires each indicator after ten seconds. The bridge targets one refresh every seven seconds per channel, sharing that schedule among overlapping mentions. A reply ends only its own pending indicator work; other mentions in that channel keep it active. Refreshes continue during the reply send and stop after the MCP reply attempt finishes, whether confirmed, failed, or uncertain. Typing failure never prevents the reply. An uncertain send retains the existing `reply_started` reservation and is never retried by typing work.

The failure timeout is **five minutes from each mention's acceptance**, not five minutes from its latest refresh. Duplicate events, subscription refreshes, restarts and retry attempts do not extend it; a separate new mention gets its own deadline. No new typing request starts for that event after the deadline. A typing request already in flight has a three-second transport timeout, and Discord may show its indicator for up to ten seconds after the last accepted request. Discord provides no explicit stop endpoint. This is best-effort feedback, not proof that the dot is executing: platform delays, rate limits, failed access checks and service interruptions may cause gaps or an earlier stop. A late dot reply remains possible after typing expires.

The existing Durable Object persists event deadlines, channel refresh/cooldown state and a global typing backoff, and merges them into its existing alarm schedule without advancing Gateway heartbeats. A transaction reserves each channel for thirty seconds before checking access and sending, so a restart during an uncertain typing request waits out that lease before trying again. One in-memory worker prevents overlapping alarm/intake loops. Refresh work runs independently of callback delivery and replies; it sends at most one typing request at a time and spaces requests across channels by at least 250 ms.

Before each refresh, the bridge checks the original subscription ownership, expiry and OAuth authorization plus live Discord membership and local grants. It rechecks durable state after those network reads. Unsubscribe/replacement, lost authorization or membership, expired origins, completed replies and terminal Gateway errors stop pending typing. Confirmed unavailable membership also stops that event's indicator; transient storage/OAuth lookup errors may retry within the original deadline. Revocation or a reply cannot retract a request already in flight, but cannot resurrect stopped work either.

Typing honors Discord's [rate-limit guidance](https://docs.discord.com/developers/topics/rate-limits): `429` retry timing and exhausted-bucket reset headers postpone the channel, and a global typing `429` postpones every typing channel. Missing/malformed retry timing, network errors and server errors use exponential backoff from fourteen seconds up to one minute. Server-provided waits are never shortened. Other HTTP errors (including denied access, missing channels and redirects) stop that pending batch. These typing controls do not change the existing reply, membership or webhook retry contracts. Channel tools separately require the permissions listed above; their use does not broaden the Gateway listener.

## Recovering a wake without its payload

Use the native event payload first: take its actual `eventId` / `data.event_id` (the Discord message ID), read `discord_get_origin_message`, then reply with `discord_reply_to_origin`. Never infer an ID from a generic wake, a previous notification, or an unrelated conversation.

If the wake has no event payload, call `discord_list_pending_mentions` with `{}`. For each entry with `status: "pending"`, read its returned `eventId` and reply through the existing tools. Follow `nextCursor` until null, including on empty pages. Start every new wake at the first page; do not retain a cursor as an acknowledgement. If no entries remain, stop. This is recovery during the same assistant’s event-triggered run, not a new polling automation, AI runtime, or API-key integration.

The recovery tool requires the existing `discord:read` scope; replying to a mention still requires both `discord:read` and `discord:reply`. Channel history, standalone sends, and own-message edits use the separate optional scopes described above. The caller and grant come from the authenticated request, not tool arguments. A mention must belong to a subscription that existed when it was accepted, match the caller’s principal, grant, client and audience, and retain a live subscription authorization. Unsubscribe, expiry, token revocation, or lost server/member access removes recovery access. Refreshing the same live subscription preserves ownership; a replacement subscription cannot recover the previous subscription’s events. No webhook URLs, signing secrets, subscription identities, other subscribers’ messages, or general channel history are returned by mention recovery.

Recovery scans at most `limit` retained origin records per call (default 10, maximum 20), in ascending storage-key/event-ID order. After five seconds of scan work, the current record is finished and remaining records move to the next page. Checks stay serial to avoid a burst of Discord requests; an in-flight member request retains its existing ten-second timeout, so the scan budget is not a hard RPC deadline. Filtering or a slow check can produce an empty page with a continuation cursor. Cursors are opaque and bound to the OAuth bearer token; after token renewal, start from the first page. Repeated reads do not acknowledge or consume anything. Later arrivals with earlier IDs are found by starting the next wake from the first page. Origin retention remains seven days; delivered webhook records may be deleted without removing recovery access. An expired origin or subscription is never resurrected for a late notification.

The tool reports `status: "replied"` only after its Discord message ID is confirmed in durable storage. A missing, expired, changed, or unreserved origin, a conflicting receipt, or a storage failure produces an unconfirmed-reply error and never automatically releases the reservation. A successful reply saves its Discord message ID on the origin and removes that origin from pending results. Repeated reply calls return `status: "replied"` and that saved ID without sending again. Concurrent calls reserve the origin transactionally before sending. `status: "reply_started"` means a send is in progress or its outcome is uncertain (for example a lost Discord response or interrupted Worker); do not resend automatically or claim success. The owner must reconcile an uncertain send before considering further action. There is deliberately no destructive read/ack tool or automatic release of an ambiguous send reservation.

Legacy origins without recorded subscription ownership are not recoverable. Previously handled messages must not be replayed. See [MCP Events](https://developers.openai.com/plugins/build/mcp-events) for the host integration contract.

## Canary sequence

Run this only after deployment, owner setup, and approval of a controlled server and member. Use synthetic text.

1. In the connected dot, subscribe to `discord.message.mentioned`. Confirm the signed callback challenge succeeds and `events/subscribe` returns a subscription ID.
2. In an approved channel, have a currently granted user or member of a granted role post a short canary that directly mentions the bot. Confirm native typing appears while the same connected dot handles the event, then stops after it replies to the original message.
3. Confirm the reply stays in the originating channel and references the original message. Use Discord's Reply on it with the ping disabled; confirm Dot responds once. Start a public thread from the bot's reply and post a plain follow-up; confirm the next reply stays inside that thread. With channel-read consent, verify the origin read includes earlier clarifications and the original parent-channel request. The MCP tool accepts only an event ID; the server resolves the destination from its saved origin.
4. Revoke the tested user or role in `/admin`. Confirm a new mention from that sender is rejected and any stored or queued event from them cannot be read, delivered, or replied to. This UI can grant the linked owner account or members of an explicitly selected role; it preserves and can revoke both grant types. Restore only the grant needed for the remaining canary checks.
5. Verify negative cases: an unapproved server, an ungranted member, a plain message in an ordinary channel or a thread started from a human's message, a reply to another human, a bot-authored message, and a DM produce no event and no reply.
6. Unsubscribe and confirm the Gateway stops when no active event subscriptions remain.

MCP Events uses a persistent webhook subscription on the authenticated `/mcp` endpoint. Callback URLs must be HTTPS, public, and use port 443. The server verifies a fresh challenge, signs event requests with Standard Webhooks HMAC, and retries transient delivery failures with bounded backoff. It does not follow redirects; `410` and `413` responses are terminal. See the [MCP Events specification](https://developers.openai.com/plugins/build/mcp-events).

## Completion record

For a failed subscription attempt, filter persisted custom logs near the attempt time for `event: discord_subscription_diagnostic`. Records identify the request, authorization, validation, callback, storage, and Gateway boundaries using fixed reasons, numeric HTTP/JSON-RPC codes, and safe scope/persistence booleans. Request records cover all POSTs to `/mcp` without parsing unauthenticated bodies; later records identify subscription processing. Invocation logging remains disabled. Do not collect raw request logs, callback URLs, credentials, or exception text.

An HTTP `200` record means the request completed; check `rpc_code` records for protocol failures. Gateway `returned` means its startup call returned, including caught failures; it does not mean Discord sent `READY`. Inspect earlier Gateway records for configuration, terminal-stop, or socket failures, and use the admin Gateway card for readiness and the active authorized subscription count. A Gateway failure with `subscriptionStored: true` means persistence preceded the failure. Callback transport records also apply to event deliveries, so inspect one controlled attempt at a time. Missing request records can indicate an upstream failure or a logging-delivery problem and do not alone prove the Worker received nothing.

Record the canary date, tested channels, grant type that was tested, and whether the dot replied in the same channel. Do not copy bot tokens, OAuth bearer tokens, callback secrets, full message contents, or other private messages into the record. A canary is complete only after the owner runs it against the live Discord bot and dot.
