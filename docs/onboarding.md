# First-run onboarding

A fresh installation begins on the new-chat landing with an explicit provider
sign-in step. The first account only powers the Personal Assistant while it
helps the user finish setup; other accounts can be added or selected later in
Settings. Onboarding never selects the protected default OpenAI or Claude
profiles, even when `~/.pi` was imported or `~/.claude` is signed in. The user
creates an isolated account through the existing account login flows. Secrets
and verification codes never go into chat.

`GET /api/onboarding` is read-only and returns `{ required, guidedSetup }`. If
the installation already has an app settings file or stored session, it is
treated as existing and is never automatically enrolled. When the user first
chooses a provider, `POST /api/onboarding/start` creates a private
`onboarding-pending` marker under `DATA_DIR` before creating the account. It
remains pending through reloads and partial setup. `POST /api/onboarding`
accepts `{ profileId }`, refuses the protected defaults, disabled or unsigned
accounts, and picks an available model for the chosen provider. It pins that
account to the permanent Personal Assistant through `saveSettings` (and enables
the Claude SDK when chosen), then writes `onboarding-complete`. Only after that
response does the client open `/assistant`. `guidedSetup` is true only when this
install completed the provider step; existing users with an empty Assistant chat
do not see the setup prompt. A settings or account change after onboarding uses
normal Settings; there is no ongoing first-run lock.

The first screen lives in the main chat pane on `/sessions/create` (and also
covers `/assistant` while setup is pending). While that screen is visible, both
side panels, the global topbar (including back/forward), and the mobile
edge-back gesture are omitted without changing saved layout preferences. The
chat header says “Welcome to Pandeck” instead of naming an unavailable session.
Once setup completes the normal shell returns. Until an account is connected,
the session inspector's Profile section says “No account or model yet” rather
than showing the draft's fallback model and thinking level. The desktop
right-panel chooser keeps Personal Assistant disabled until its model is
available on a signed-in account; Knowledge and Worktree panels are opt-in in
Settings → Appearance. The sidebar bottom bar offers only Settings until an
account and model are ready, without losing the user's saved navigation order.
The empty Sessions inbox does not direct users to New Session before it is
available. Account login and retry stay there; only the conversational setup
follows in the Personal Assistant. The account step is not tied to any
CLI/default account, and an interrupted sign-in can be resumed with the same
named account. The provider/model can be changed later in Settings → Personal
Assistant.
