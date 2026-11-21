# First-run onboarding

What a new install shows before it can run anything, and how it hands over to
the normal app. A fresh install creates no accounts, so its account list is
empty and nothing can start until the user connects one.

First run has three states: the welcome screen while no account works
(`pending`), then a guided setup chat with the Personal Assistant (`setup`),
then the normal app (`complete`). Guided setup covers the assistant's name, more
accounts and the model picker (step 3a), then Git, GitHub and the Projects and
worktree folders (step 3b); the other integrations and memory are planned as
step 3c and do not exist yet.

## The onboarding state

The server owns whether an install is on its first run
(`app/server/src/onboarding.ts`). `DATA_DIR/onboarding.json` holds
`{ "state": "pending" }`, `"setup"` or `"complete"`, written atomically with
mode 0600. It only moves forward: `pending → setup → complete`.

- **Decided once, at boot.** With no file, boot classifies the install before
  anything it does can change the answer. It is fresh only when it has no app
  settings file (`DATA_DIR/settings/app.json`), no session rows, no credential
  profiles, and is not a gateway client (`ASSISTANT_GATEWAY_RELAY`), whose
  accounts arrive from the remote gateway after boot. A fresh install is written
  `pending`, anything else `complete`. Later boots read the file, so an
  established install never sees first run and is never renamed or re-pinned. A
  file holding `setup` reads back as `setup`, so a reload or restart returns to
  the setup chat. An unreadable file, or an unknown state, reads as `complete`.
- **Boot never fails over the marker.** If the decision cannot be read or
  persisted (no space, read-only disk, a blocked path), the server warns and
  treats the install as `complete` in memory for this boot: no welcome, no
  naming. A later boot decides again.
- **`complete` is final.** Nothing moves an install back to `pending` or
  `setup`.
- **The server begins setup.** While `pending`, it checks for a usable account
  wherever it learns accounts may have changed: an account created, enabled,
  signed in, an endpoint saved or its models discovered
  (`subscribeCredentialProfileChanges`), the Claude SDK switch saved, an account
  listing, and boot. An account is usable when it is enabled, signed in
  (`status: "ready"`) and offers at least one model. The model check is what
  makes a Claude account count only while Settings → Claude SDK is on. Checks
  never overlap, and once past `pending` they cost nothing.
- **Order into setup.** Leaving `pending` runs in an order where any failure
  leaves it `pending` for the next check to retry: pin the assistant's model
  (below; a no-op once it can run), name the assistant (below; a no-op once
  named), retire a Personal Assistant conversation bound before setup (so the
  next one carries the setup prompt), persist `setup`, take it in memory, then
  broadcast it once. A pin or name that was saved but whose follow-up effects
  failed counts as done and is neither redone nor undone. The pin goes first
  because a leaf write carries the whole current section: written after the
  name, the default model would be stored as if the user had chosen it.
- **Pinning the assistant's model.** When the saved Personal Assistant slot has
  no stored model, or one that no enabled, signed-in account can run, the server
  runs the assistant on the account it just found, as leaf writes of
  `permanentAssistant.provider`, `modelId`, `thinkingLevel` and
  `credentialProfileId`: Claude's `opus` alias at medium thinking; on OpenAI the
  default helper model (`DEFAULT_HELPER_MODEL`) when the account offers it, else
  its first Codex model; on an OpenAI-compatible endpoint its first model. The
  latter two start at high thinking, clamped to what the model supports. A
  stored slot that can run is never touched. The runnability check is async, so
  the write re-reads the slot in its synchronous step and leaves a model another
  writer saved meanwhile in place. The normal settings effects run.
- **Naming.** When no Personal Assistant name is saved (none, blank, or the
  default "Personal Assistant"), the server saves **Larry**. It is a leaf write:
  the stored name is re-read and the rest of the section taken from the current
  settings in the same synchronous step as the write, so a value another writer
  saved is never replaced, and the normal settings effects (rotating the
  Personal Assistant, announcing the change) run. A saved name is never
  overwritten. An established install keeps "Personal Assistant".
- **Account health is not read**, on purpose. An enabled, signed-in account
  whose login the provider later rejects (`needs-login`) keeps the normal shell
  and the app status alert (`account-routing.md`).

- **Finishing setup.** `finishOnboarding()` ends `setup`. Two things call it:
  the setup screen's **Finish setup** button (`POST /api/onboarding/finish`,
  answering `{ state }`), and the assistant's `onboarding_finish` tool when the
  user says they are done or want to skip the rest. It rotates the Personal
  Assistant first, so the assistant's next conversation is a fresh one without
  setup instructions, then persists `complete`, takes it in memory and
  broadcasts it once. A failure leaves `setup` and reports it; finishing again
  retries. Overlapping calls share one run. Outside `setup` it changes nothing:
  the route answers the current state, the tool refuses.
- **The setup conversation runs nothing after setup.** Rotation only rebinds the
  singleton; the setup session itself stays on disk and readable, and can still
  be reached (a view left open, a `/sessions/<id>` link, a peer or session tool,
  a queued message, a resume). Its prompt was frozen with the setup section and
  finish tool, and frozen prompts never change, so once the state is no longer
  `setup` the prompt door (`session/runtimePrompt.ts`) refuses every turn in a
  session whose frozen conditions carry `guidedSetup`, before the runtime
  session and any append, with "Setup is finished. Continue in your Personal
  Assistant." (`SetupFinishedError`). That covers prompts, steers,
  provider-initiated turns and account-recovery continuations. Host commands
  (`/compact`, `/clear`, `/commit`, `/push`, `/pr`) are refused the same way at
  admission: each runner in `hostSlashCommands.ts` checks first, before a
  synthetic turn opens, whichever dispatcher (the viewed session, the prompt
  queue) calls it; `/compact` checks again after its memory flush, right before
  the model-backed compaction. Automatic compaction only happens inside a turn,
  and the helper one-shots (naming, status) bring their own system prompt, so
  neither can carry the setup prompt. The turn that called `onboarding_finish`
  itself runs to its end. A send or host command from the browser refused this
  way carries `setupFinished: true` on its `error`.

The `ready` snapshot carries `onboarding`, and each change is broadcast once as
`{ type: "onboarding", state }`. The browser keeps it as live state only: it is
`null` until `ready` and never restored from the shell cache. The welcome screen
shows only while it is `pending`, the setup screen only while it is `setup`.
Unknown is never first run, and the account projection, cached or live, only
fills the card's rows.

## The welcome screen

On the New Session routes (`/sessions/create` and `/sessions`), first run
replaces the agent/account picker with the welcome screen
(`components/FirstRunWelcome.tsx`, hosted by `components/FirstRunSetup.tsx`):

- A greeting headed **Welcome to Pandeck**, rendered with the shared
  assistant-message renderer (`AssistantMessage`). The app writes it; it is
  never stored and never generated by a model. It introduces the assistant by
  its saved name, shown as plain text, or as **Larry** when no name is saved,
  and says why an account is needed.
- A full-width card, **Connect your first AI account**, with one row per account
  kind, named as Settings names them: Claude, OpenAI (sign-in with a ChatGPT
  plan, the `openai-codex` kind) and an OpenAI-compatible endpoint.
- The real composer below it, visible but inert: it takes no text, shows only
  its field and a disabled Send, and its placeholder says to connect an account.
  The New Session screen's "no visible models" refusal is not shown here.

### The account card

Each row either creates the first account of its kind or continues an earlier
one, so an interrupted sign-in resumes on the same account instead of creating
another (`firstAccountSteps`). An enabled account is preferred over a disabled
one of the same kind.

| The row's account                  | Button           | What it does                                    |
| ---------------------------------- | ---------------- | ----------------------------------------------- |
| none yet (Claude, OpenAI)          | Sign in          | creates the account, opens the sign-in dialog   |
| none yet (endpoint)                | Set up           | creates the account, opens its Settings section |
| disabled                           | Turn on          | enables it                                      |
| login still running                | Continue sign-in | reopens the sign-in dialog                      |
| not signed in, or sign-in failed   | Sign in (again)  | opens the sign-in dialog                        |
| Claude, signed in, Claude SDK off  | Continue         | turns Settings → Claude SDK on                  |
| endpoint without address or models | Continue setup   | opens its Settings section                      |

A new account is named after its kind ("Claude", "OpenAI", "OpenAI-compatible")
until the user renames it in Settings.

Sign-in uses Settings' own login dialog (`AccountLoginDialog`): Claude's
authorization link and code paste, or OpenAI's device code for a ChatGPT plan.
Nothing about the sign-in enters the chat. When the login finishes the dialog
closes by itself and the account list is re-read, and the server ends first run
when it sees the account; there is no second confirm step. A Claude account runs
only while Settings → Claude SDK is on, which is off by default, so a Claude
sign-in finished from the card, or its Continue, turns that switch on. Once the
server confirms the switch changed (its `settings` message), the browser reads
the accounts again as a new request rather than joining one that started before
it. Continue also re-reads at once, for a switch that was already on. Cancelling
closes the dialog and leaves the account for the row to continue later.

An endpoint is configured where it always is, in Settings → OpenAI-compatible
endpoints: the card creates the account and opens that section. Settings' Close
returns to the welcome screen on wide layouts, and the nav bar's New Session on
every layout.

### The assistant's name

The greeting introduces the saved name as plain text, or **Larry** while none is
saved; the server saves Larry when setup begins (above).

### The focused shell

While the welcome screen shows, the shell omits both side panels, the desktop
top bar (with its back/forward arrows) and the mobile edge-back gesture
(`welcomeScreen` in `App.tsx`). The saved layout preferences are not changed, so
the panels come back as they were. The chat header is hidden; the greeting's
heading names the screen.

Anywhere the sidebar does show during first run (Settings), its navigation bar
offers only New Session, which shows the welcome screen while first run lasts,
and Settings, without changing the saved slot order (`Sidebar`'s `firstRunNav`).
So on a phone, Back from Settings leads to a nav bar that returns to the welcome
screen.

## Guided setup

When the state becomes `setup`, the browser opens `/assistant`, the Personal
Assistant's chat, wherever the account was finished (the welcome screen or
Settings). While `setup` lasts, the New Session routes lead back to it,
replacing their history entry so Back does not bounce.

### The setup screen

- The same focused shell as the welcome screen (`focusedShell` in `App.tsx`): no
  side panels, desktop top bar or edge-back. The sidebar's reduced nav (New
  Session and Settings) applies too.
- A compact header headed **Welcome to Pandeck** with **Finish setup**
  (`components/GuidedSetup.tsx`, `GuidedSetupHeader`). The button shows busy
  while the request runs; a failure shows under the header and setup stays.
  Success needs nothing local: the server's broadcast removes the header and
  brings back the normal shell around the same chat.
- When setup ends while `/assistant` shows the setup conversation (by the button
  or the tool), the view stays on it until its current turn has ended, so the
  assistant's closing reply is not cut off, and then opens the assistant's
  current conversation (`reopenPermanentAssistant` in `useSessionRouting`). A
  reload or a later visit opens that one anyway. A send refused with
  `setupFinished` (a retained view, a deep link) lands the browser on
  `/assistant` the same way.
- An app-authored greeting (`GuidedSetupGreeting`, text from `setupGreeting` in
  `lib/firstRun.ts`), rendered with the shared `AssistantMessage`, that says the
  account is connected and asks whether to keep the assistant's name or choose
  another. It is never stored and never generated. Before the first message it
  stands in for the transcript; afterwards it sits above the first durable row
  (`MessageList`'s `intro`, shown once the transcript reaches its start). It
  shows on every load while `setup` lasts.
- The real composer, enabled.

### The setup conversation

A Personal Assistant session created while the state is `setup` freezes the
`guidedSetup` prompt condition (`promptConditions.ts`; the acquisition passes it
as evidence). Like every condition it is decided once, at session start, so a
session started before setup never gains it and the setup session keeps it until
it is rotated. Unlike the others it fails closed: a stored record without the
key, or a caller with no conditions, gets no setup section and no eager finish
tool.

That session carries `config/prompts/onboarding-setup.md`: the app already
greeted the user and asked about the name, so their first message answers it;
then, one question at a time and each skippable, more Claude or OpenAI accounts
(`accounts_read`, `accounts_update`, `accounts_sign_in`; never a secret in chat;
distinct names when two accounts share a provider) and which models the picker
shows (`models_read`, then `settings_update` of `models.hidden` after the user
agrees, keeping the assistant's own model shown); then the developer steps
below; then it offers to finish and calls `onboarding_finish`. The settings
tools, `git_setup_read` and `github_pat_setup_link` among them, stay deferred,
and the section tells the assistant to load them by name: they are 9 tools in
one group, more than a "settings" search loads at once. `onboarding_finish` is
eager only in this session (`eagerWhen: "guidedSetup"`) and deferred in every
other Personal Assistant session, where it refuses.

### Developer steps (3b)

The section orders them; each tool's description carries its own rules
(`settings.md` for the tools, `github.md` for the token).

1. **Git.** `git_setup_read` reports whether `git` runs on the session's Worker,
   its version, and whether the global `user.name` and `user.email` are set. Its
   description has the assistant call it before saying anything about Git,
   report what it returns and never change the host's Git config. It is
   read-only, and a check that could not run is an error, never "not installed".
2. **GitHub**, if the user wants it. The assistant asks for their GitHub
   username, never a token, and calls `github_pat_setup_link`, which refuses an
   invalid login and returns the classic token link with the scopes and what
   each is for, which the assistant shows. The token is entered only in the
   private card `settings_request_input` raises for `github.token`; that card
   shows the same link above its field (the registry's `setupLink`). Once the
   token is saved, one `settings_update` turns `github.enabled` on and runs the
   `github` test, whose "Authenticated as …" names the login. The assistant
   saves the username as `github.defaultOwner` only when that login matches it
   or the user confirms which is right. Declining leaves GitHub off.
3. **Folders.** The assistant shows `projectsRoot` and, when Git is installed,
   `worktrees.root` as `settings_read` returns them (resolved, defaults filled
   in), asks about each separately, and changes one only to an absolute path the
   user confirms. Nothing creates or moves a directory.

`models_read` lists each enabled, signed-in account's models with their
`provider:modelId` key and whether the picker shows them, plus the assistant's
own model key; an account whose models cannot be listed says so instead.

A rename during `setup` does not rotate the assistant: it would wipe the live
setup chat (`assistantChangeRotates` in `settingsService.ts`, which both the
rotation effect and `settings_update`'s restart note use). Any other profile
change rotates as always. A Claude session keeps the name it started with in its
profile line, so the setup section tells the assistant to use a newly chosen
name from then on.

### Not yet built

- **3c**: the other integrations (Forgejo, Jira/Confluence, Google, Slack,
  Tempo, web search) and the Memory opt-in.

## Wire

The `ready` settings projection carries `permanentAssistant`, so the greeting
names the assistant before Settings has ever been read. `OnboardingState` is
`"pending" | "setup" | "complete"`, carried on `ready` and the `onboarding`
broadcast. An `error` answering a send to the finished setup conversation
carries `setupFinished: true`; the client counts them (`setupFinishedRefusals`)
rather than reading the sentence.
