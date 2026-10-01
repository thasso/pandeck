# Slack integration

## App configuration

The Pandeck Slack app uses OAuth for personal and bot credentials and outbound
Socket Mode for private interactions. It requires no public Slack event
endpoint, so a Tailscale-only deployment remains private.

## Personal Web API tools

Documented Slack reads use only the connected personal user OAuth token, through
separate capabilities for message search, one-conversation history, one thread,
and personal unread aggregation. A single unread call enumerates bounded
accessible public/private channels, DMs, and group DMs; reads messages after
each user-specific `last_read`; labels DMs/MPIMs; and supports
conversation/person filters plus global/per-conversation limits. Missing markers
are returned as uncertainty rather than zero unread. Optional unread-thread
expansion is explicitly best-effort because Slack exposes no global personal
thread-read marker, so replies on older roots can be absent.

Search hits can opt into bounded thread and nearby-channel expansion; reply hits
include their bounded root/thread context. Focused thread reads require the root
timestamp exposed as `threadTs` by search/conversation results and paginate
within configured limits. Conversation reads accept IDs, channel names, or an
unambiguous person name for a DM; MPIMs are labeled by participants. User
discovery matches normalized username, display name, real name, and—only when
`users:read.email` was granted—email. Duplicate names and deleted-only matches
return bounded candidates instead of guessing. Message output resolves authors
plus user, channel, and user-group references to readable names while retaining
stable Slack IDs in structured fields. Workspace-and-token-scoped metadata
caches expire after five minutes.

Message results also preserve bounded Block Kit links, legacy attachment
metadata, and file ids/metadata without exposing Slack private download URLs.
The focused `slack_file_read` capability accepts one returned file id plus
optional originating conversation/message/thread metadata. It uses `files.info`
and authenticated private downloads with the personal user token, manual bounded
redirects restricted to Slack-owned file hosts, a 15-second timeout, a 20 MiB
hard download ceiling (10 MiB default), and a 100,000-character hard extraction
ceiling (20,000 default). Only text-like MIME types are decoded directly. PDFs
currently have no safe extractor dependency in this repository and therefore
return metadata-only, as do other binaries, external files, deleted files, and
permission-restricted files. Download MIME disagreement also degrades to
metadata-only. Authorization headers and private/signed URLs are never included
in results or errors.

Every result identifies the personal OAuth identity boundary and preserves real
message permalinks. These tools never read the Huddle credential file or receive
bot/browser-session credentials. Experimental Huddle attendance and private
web-client Later APIs are not part of this public read surface.

## Experimental Huddle history

`slack_huddle_history` is a separately gated capability for personal attendance,
participants, timing, and duration. It uses Slack’s undocumented
`huddles.history` browser endpoint and may break when Slack changes its web
client. Enable and refresh it only through **Settings → Slack Huddles** by
pasting a copied `huddles.history` cURL. The parser rejects other private Slack
API requests and retains only the browser token and `d` cookie; full cookie
headers and frontend/build fields are discarded.

Browser material is stored separately in `DATA_DIR/settings/slack-huddles.json`.
Normal OAuth/bot settings remain in `slack.json`; search, conversation, thread,
unread, file, Socket Mode, bot chat, and Task intake code never read the Huddle
credential file. Huddle health has independent save/test/clear/disable controls
and does not run during normal Slack health checks. Disabling Huddles removes
only `slack_huddle_history`; integration enable changes push MCP
`tools/list_changed`, so live pi and Claude sessions reconcile their active tool
lists without restarting.

The tool defaults to compact bounded results, accepts an optional user-local day
and a maximum of 100 records, never returns raw Slack objects, and caps
personal-OAuth metadata enrichment at 40 calls. Browser credentials are used
only for history; optional personal user OAuth resolves conversations,
participant names, and bounded thread-room attendance evidence. Missing
self-attendance or end-time evidence remains explicitly unknown.

Slack Later browser access and `saved.list` are not supported.

Configure the Slack app with:

- **OAuth redirect URL:** `<public assistant origin>/api/slack/oauth/callback`.
- **OAuth scopes:** grant at least the `DEFAULTS.slack.userScopes` and
  `botScopes` lists in `app/server/src/config.ts`; a deployment config overrides
  `slack.userScopes`/`slack.botScopes` only to match an app that grants a
  different set. The server sends bot scopes through `scope` and personal scopes
  through `user_scope`.
- **OAuth app credentials:** keep the nonsecret client id in `slack.clientId` or
  `ASSISTANT_SLACK_CLIENT_ID`. Supply the client secret only through
  `ASSISTANT_SLACK_CLIENT_SECRET`.
- **Socket Mode:** enabled, using the app-level token supplied only through
  `ASSISTANT_SLACK_APP_TOKEN`.
- **Interactivity:** enabled; no Request URL is required when Socket Mode is
  enabled.
- **Message shortcut:**
  - Name: `Create task in Pandeck`
  - Callback ID: `personal_assistant_create_task`
  - Location: Messages
- **Event subscription:** `message.im` for private bot conversations.
- **App Home:** Messages tab enabled for private bot conversations.

Exactly one instance of this deployment may hold a Socket Mode connection for
the app: Slack load-balances each event across all open connections, so a second
connected instance silently receives a share of the real DMs and shortcuts, into
its own DATA_DIR. `ASSISTANT_SLACK_APP_DISABLED=1` is the kill switch for an
instance that must not be that one: `config.ts` resolves the captured app token,
client id, and client secret to the empty string, so the client reports
`disabled` and never calls `apps.connections.open`. PR previews set it
regardless of their preview-only environment files (see `docs/deployment.md`);
user/bot OAuth tokens under `DATA_DIR` are untouched, so the Web API read tools
above still work there.

OAuth scopes and the pinned workspace/team are owned by `config/app.json` and
`app/server/src/slackSettings.ts`. The end-user browser receives only enablement
and connection booleans—not scopes, workspace/user IDs, redirect details, or
credentials. Existing authorization is checked automatically when Settings
opens; recovery is sign out, then sign in again. OAuth state is ten-minute,
single-use state consumed before token exchange.

## Private message-shortcut intake

`app/server/src/slackShortcutIntake.ts` consumes authorized `message_action`
envelopes from `slackSocketMode.ts`. Socket Mode acknowledges envelopes before
any intake work.

Intake behavior:

1. Reject shortcuts not sent by the connected user in the configured workspace.
2. Persist a minimal Task before remote enrichment, using a deterministic Slack
   archive URL as its source link and attaching the active project selected in
   **Settings → Task intake agent**, when configured.
3. Fetch the selected message, bounded thread/nearby context, permalink,
   conversation name, and user display names with personal user OAuth. Socket
   envelopes are capped at 1 MB; intake Web API responses are streamed with a 1
   MB limit and 15-second timeout; message text, attachment collections, private
   feedback blocks, and generated Task context are bounded before persistence.
4. Run the configurable Task Intake Agent over that bounded context. It can
   perform up to ten targeted read-only research calls through enabled Personal
   Assistant integrations (for example Slack, Gmail, Drive, Calendar, Jira,
   project registry, Tasks, and Knowledge Base); native file/shell tools and
   every mutation tool remain unavailable. All retrieved content is treated as
   untrusted source material.
5. Strictly validate its `{ title, description }` JSON output. Descriptions
   begin with `## Action`, add Context/Details/Open questions only when useful,
   and omit source metadata already stored by the app. Update the Task with the
   curated title/description and source link. If Slack context, research, or
   curation fails, retain the Task and a durable retry marker; using the
   shortcut again retries the complete enrichment flow.
6. Immediately after the minimal Task is persisted, open the invoking user's
   private Pandeck App DM and post a styled “Task accepted” progress message.
   Update that same message with the curated Task title or a retryable failure,
   plus links to the permanent PA Task route and original Slack message. If that
   Slack message already has a completed intake Task, post a fresh linked “Task
   already exists” message in the App DM. Interaction-response and ephemeral
   delivery remain fallback-only; never post a reaction or visible message in a
   shared channel.

The optional automatic project is resolved against the current project registry
for each new intake. A missing or archived configured project is skipped rather
than blocking Task persistence. The source link identifies the Slack message by
channel and timestamp. Its metadata title uses a human conversation label such
as `#product`, `DM with Burcin Aksay`, or `group DM with …`; the curator is told
not to duplicate that link/label in the Task description. Repeated envelope
delivery or repeated shortcut use reuses the existing Task. Task Intake Agent
provider, model, thinking level, and additive style instructions are configured
in **Settings → Task intake agent**. If context loading or curation fails, the
minimal/context-enriched Task remains marked as pending; using the shortcut
again retries enrichment.

Task writes push an authoritative active Task list to every connected web
client, and each fresh web connection receives the current list so browser tabs
and installed PWAs converge instead of retaining separate cached lists.

Message bodies and interaction response URLs are not written to server logs.
Logs contain only redacted receipt/result metadata. Interaction response URLs
are accepted only on Slack's HTTPS hooks host; malformed, oversized,
wrong-workspace, wrong-user, and duplicate envelopes fail closed.

## Private Assistant conversation

Authorized `message.im` events are consumed by `slackAssistantChat.ts` and
de-duplicated by workspace/channel/message timestamp before entering the
permanent Assistant's durable FIFO queue. Bot messages, message subtypes, empty
messages, and other users are ignored.

The bot immediately posts `Working on it…`, or a queued notice when another turn
is active. Queue completion converts common model Markdown to Slack `mrkdwn` and
updates that same private bot message with the answer; failures replace it with
retry guidance. `chat.update` is not tied to a short-lived interaction response
URL, so long-running turns do not expire, and transient final-update failures
are retried with backoff. A failed placeholder post never loses the queued user
request. Slack does not expose a supported Web API for making a bot emit the
native “is typing” indicator, so the private placeholder is the durable progress
signal. Slack and web therefore share one singleton conversation and strictly
ordered turns.
