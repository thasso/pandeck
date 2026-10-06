# First-run onboarding

A fresh installation begins on the new-chat landing with an explicit provider
sign-in step. The first account only powers the Personal Assistant while it
helps the user finish setup; other accounts can be added or selected later in
Settings. No installation creates or lists default OpenAI or Claude accounts,
imports `~/.pi`, or adopts `~/.claude`; every runnable account needs an
explicit, isolated Pandeck login. Retired default profile records and credential
files remain on disk, but are not usable. Existing sessions bound to them remain
viewable but cannot run until the user creates a managed account and starts a
new session. The user's first isolated account has no custom name; its label is
“Claude” or “OpenAI” until renamed. Secrets and verification codes never go into
chat. For Claude, a clean CLI exit is verified with `claude auth status --json`
under that account's isolated `CLAUDE_CONFIG_DIR` when the legacy
`.credentials.json` file is absent; a non-secret marker records the verified
result. On account-list refresh, the same check recovers an earlier successful
sign-in without asking for OAuth again.

`GET /api/onboarding` is read-only and returns `{ required, guidedSetup }`. If
the installation already has an app settings file or stored session, it is
treated as existing and is never automatically enrolled. When the user first
chooses a provider, `POST /api/onboarding/start` creates a private
`onboarding-pending` marker under `DATA_DIR` before creating the account. It
remains pending through reloads and partial setup. `POST /api/onboarding`
accepts `{ profileId }`, refuses retired defaults, disabled or unsigned
accounts, and picks an available model for the chosen provider. Claude starts
with the `opus` alias and medium thinking. OpenAI prefers `gpt-6-luna` with high
thinking; if that account does not offer Luna, the first available OpenAI Codex
model is chosen with the closest supported thinking level. It pins that account
to the permanent Personal Assistant through `saveSettings` (and enables the
Claude SDK when chosen), retires any earlier empty Assistant binding, then
writes `onboarding-complete`. The next acquisition receives the guided prompt
without deleting that old session. Only after that response does the client move
the same focused chat to `/assistant`: the sidebar stays hidden, the real
composer becomes available, and the initial greeting and provider card remain
above a scripted assistant message asking whether the user wants to rename
Larry. The card becomes an inert connected receipt, not an actionable login
again; the local-only history stays above durable turns in the same scroll owner
across reloads. There is no Finish setup action yet: `guidedSetup` keeps the
chat focused while more basics are developed. An older `finished` marker still
identifies an existing installation rather than reenrolling it. Existing users
with an empty Assistant chat are never enrolled automatically. During guided
setup a name change does not rotate the live Assistant session, so its
conversation stays intact; other profile/model changes retain their normal
rotation behavior.

The first screen lives in the main chat pane on `/sessions/create` (and also
covers `/assistant` while setup is pending). The assistant defaults to the name
Larry (existing custom names are preserved). A scripted, app-authored greeting
headed “Welcome to Pandeck” uses the shared assistant-message renderer to
introduce Larry in the message text and explain why a provider account is
needed; a full-width account-selection card follows it above the real composer,
which stays visible but cannot accept text or send until an account is
configured. The card has no redundant setup label or CLI footnote. A previously
connected account appears as one Continue button, and completing a new login
advances automatically; neither needs a second confirmation button. Neither the
scripted greeting nor the card is stored or model-generated; account sign-in
still happens outside chat. While that screen is visible, both side panels, the
global topbar (including back/forward), and the mobile edge-back gesture are
omitted without changing saved layout preferences. The chat header says “Welcome
to Pandeck” through the guided conversation. Once the user finishes setup the
normal shell returns. Until an account is connected, the session inspector's
Profile section says “No account or model yet” rather than showing the draft's
fallback model and thinking level. The desktop right-panel chooser keeps
Personal Assistant disabled until its model is available on a signed-in account;
Knowledge and Worktree panels are opt-in in Settings → Appearance. The sidebar
bottom bar offers only Settings until an account and model are ready, without
losing the user's saved navigation order. The empty Sessions inbox does not
direct users to New Session before it is available. Account login and retry stay
there; only the conversational setup follows in the Personal Assistant. The
account step is not tied to any CLI/default account, and an interrupted sign-in
can be resumed with the same account. The guided Assistant prompt asks one
question at a time: its name, additional provider accounts (with distinct names
when a provider has multiple accounts), model-picker visibility via
`models_read` and `settings_update(models.hidden)`, then the host Git check
(`git_setup_read`) and optional GitHub connection. A GitHub username creates a
prefilled classic PAT link (`github_pat_setup_link`) with the GitHub scopes in
[`github.md`](github.md); the PAT is collected only by `settings_request_input`,
never in chat. Regardless of GitHub choice, Larry shows the actual
`projectsRoot` and, when Git is installed, `worktrees.root` before offering
separate changes. A multi-choice `ask_questions` card then lets the user select
Forgejo, Jira/Confluence, Google, Slack, Tempo or Brave Web Search, including
none; chosen connections follow their Settings descriptors and secret/OAuth
cards. Memory opt-in comes afterward. Each reply asks the next concrete question
instead of only promising more setup. Memory stays off unless explicitly
enabled. The provider/model can be changed later in Settings → Personal
Assistant.
