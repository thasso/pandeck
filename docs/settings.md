# Settings

Everything the Settings page reads or writes is described in one registry,
written through one service, and pushed to every connected client. The Personal
Assistant uses the same registry and service, so anything the user can set, the
assistant can set too, and secrets stay out of its context
([Task-729](pa://task/729)).

## The registry

`app/shared/settingsRegistry.ts` holds one descriptor per setting:

- `path`: a dotted path into `AppSettings` (`sessionNaming.enabled`,
  `projectsRoot`). Integration secrets and OAuth connections name the patch
  field that writes them (`github.token`, `google.connection`).
- `section`: the Settings page section it appears in. `SETTINGS_SECTION_IDS`
  lives here too, and the web routes use it.
- `access`: one of
  - `value`: read and written as is.
  - `readonly`: deployment config or derived status (the Atlassian host, a
    discovered account email). Shown, never written. One the Settings page
    echoes back in a patch declares the kind it reads as, so a wrong-kind echo
    is refused.
  - `secret`: write-only. A read reports only the `configuredBy` flag. Writing
    `null` sets the `clearWith` patch flag.
  - `oauth`: connected through a browser flow. Only `null` (disconnect, via
    `clearWith`) can be written.
- `value`: the kind and bounds a write must have. The Settings page reads its
  number inputs' limits from it (`settingBounds`). Every settings message is
  kind-checked against it by `appSettingsPatchError` in
  `validateClientMessage.ts`: each present leaf of a writable setting must be
  its registry kind, and each object on the way to it an object. Bounds and
  vocabularies stay with the normalizers there, which clamp what an older or
  hand-edited client sends; the agent path checks them strictly. A `json` value
  (a model list, the peer runtime roster, skill toggles, the dictation
  vocabulary) is written whole and passes its deep check in
  `JSON_SETTING_VALIDATORS`; a test requires one for every `json` setting.
- `optional`: writing `""` removes the field, for example an account pin back to
  automatic.

A section with nothing in the registry, or that shows something the registry
does not hold, says what and where in `SETTINGS_OUTSIDE_REGISTRY`: Claude and
OpenAI accounts are credential profiles, push subscriptions and port forwards
belong to a device, and the About page has nothing to set.

The Appearance section's `knowledgePanelEnabled` and `worktreePanelEnabled`
switches default off. Knowledge visibility controls the sidebar and desktop
right-panel picker; Worktree visibility controls its right-panel entry. Neither
disables the underlying Knowledge Base or worktrees. The sidebar also waits for
onboarding, signed-in models, and enabled integrations before offering their
respective destinations. Startup settings include the relevant sections so these
choices take effect without visiting Settings first.

## Coverage

Three tests keep the registry complete:

- `app/shared/settingsRegistry.test.ts`: paths are unique, every page section
  has descriptors or an entry in `SETTINGS_OUTSIDE_REGISTRY`, and each access
  class carries the fields it needs.
- `app/server/src/settingsService.test.ts`: every leaf of `getSettings()` is
  covered by a descriptor (directly, under a `json` or `readonly` subtree, or as
  a secret's `configuredBy` flag); every descriptor points at a real value or
  patch field; every integration patch field is written by some descriptor. The
  leaves are read with every optional field filled in (an account pin on every
  slot, all day-scan identities), since defaults leave them out.
  `INTEGRATION_PATCH_FIELDS` lists the patch fields, so adding one to a
  `*SettingsPatch` type is a type error until it is listed there.
- `app/server/src/architecture.test.ts`: no module outside `settingsService.ts`
  calls `updateSettings` or an `update*Settings` writer.

## The write path

`saveSettings(patch)` in `app/server/src/settingsService.ts` takes a patch keyed
like `AppSettings`, with integration sections in their `*SettingsPatch` shape.
It writes app sections through `updateSettings` (each section replaced whole)
and integration sections through their own module, then runs what the written
sections need:

| Section written       | Effect                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `permanentAssistant`  | A changed name, model, thinking level or instructions rotates the Personal Assistant to a fresh session |
| `memory`              | Enabling/disabling Memory updates live tools and rotates the Personal Assistant for its frozen prompt   |
| `dayScan`, `profile`  | Re-arm the daily scan schedule                                                                          |
| `slack`               | Reconcile Socket Mode                                                                                   |
| `github`              | Reconcile the package proxy                                                                             |
| `openAiCompatible`    | Sync the configured model providers                                                                     |
| any other integration | `notifyIntegrationToolsChanged` (live `tools/list_changed`)                                             |

The service imports no engine (`docs/agent-harnesses.md`): the model-provider
sync is the engine's `syncConfiguredModelProviders`, installed at boot by
`index.ts` through `setModelProviderSync`.

Then every `onSettingsChanged` listener hears which sections were written. The
hub forwards that to each connection's `settingsChanged`, which sends that
client its own `settings` (OAuth redirect URIs depend on the connection's public
URL), plus `models` after a `claudeSdk` or `openAiCompatible` write and
`speechToTextStatus` after a `speechToText` write. The writer gets its echo the
same way as everyone else, before the request's `mutationSettled`.

Each effect and each listener runs on its own, so one failure never skips the
rest or the announcement. A section counts as written once its writer has run,
even if the writer then threw, because a writer may persist before it fails.
When a write fails, the sections it reached still run their effects and are
announced, and then the write's own error is thrown. When every write lands but
an effect fails, the error says the settings were saved and names what failed.
Listener failures are only logged. A save reads full settings only when it
touches `permanentAssistant` or `memory`, so one unreadable integration file
never blocks saving an unrelated section.

`announceSettingsWritten(sections)` covers settings a module persists on its
own: an OpenAI-compatible connection test stores the models it discovered, and
the Google, Slack and Tempo OAuth callbacks store tokens. It runs the same
effects and pushes the same per-connection update.

`settingsPatchForWrites(writes)` turns path-addressed writes (`{ path, value }`)
into such a patch. It checks each against its descriptor, copies the rest of the
current section for a leaf write into an app section, and refuses unknown paths,
read-only settings, bad values and non-null OAuth writes.

The connection-test messages (`saveAndTest*`, `test*`) still answer only the
client that asked: a test result is that client's request, not shared state.
What a test persists, such as discovered models, reaches every client.

## Agent tools

The Personal Assistant, and no other persona, has a deferred `settings` tool
group (`app/server/src/tools/settings/settingsTools.ts`):

- `settings_read`: with no arguments, the section list (and for each section
  without settings, why). With `section` or `paths`, each setting's value, type,
  access and hint. A `secret` reports `configured`, an `oauth` connection
  reports `connected`; neither value is in `getSettings()`, so neither can be
  returned.
- `settings_update`: path writes through `settingsPatchForWrites` and
  `saveSettings`, read back so the agent sees what was stored after
  normalization. A secret accepts only `null` (clear); any other value is
  refused with a pointer to the section's Settings page, so the user never
  pastes a token into the chat. `test` runs a section's connection test through
  `testSettingsSection`, the same tests the page runs. When the write changes
  the assistant's own profile, the result says the user's next message starts a
  fresh Personal Assistant session. A credential the save dropped because its
  URL moved to another host (see below) is listed under `credentialsCleared`,
  with a note to ask the user again through `settings_request_input`.

`settings_update`, `settings_request_input`, `accounts_update` and
`accounts_sign_in` are `local` side effects, so Plan mode keeps only
`settings_read` and `accounts_read`.

Both tools hold four guarantees the schema alone cannot give, since neither
harness enforces it before `execute`:

- **Arguments are checked in full first.** Unknown fields, unknown sections,
  over-long arrays and a change without its own `value` are refused before
  anything is written; an omitted value is never read as `null`, so a malformed
  call cannot clear a secret or disconnect an account.
- **A failed connection test is reported in the server's words**: the section,
  the HTTP status when there was one, and the Settings page that shows the
  details. The tests' own failure text was written for that page and quotes what
  the endpoint sent back, which may echo the credential it received, and no
  scrubbing of free text can be complete (a key may be short, or replaced while
  its test is out). A success message is scrubbed of every credential stored
  before the test started, at any length, and every one stored after.
- **Everything else returned or thrown is scrubbed** by
  `app/server/src/secretRedaction.ts`. It removes every stored secret (any
  string under a token/key/secret/cookie/password key in the private settings
  files, plus the deployment secrets) as itself, URL-encoded, base64, and as a
  base64 `user:secret` basic-auth pair; a secret cut off at the end of a
  truncated message; credentials in any URL, up to the last `@` before the path;
  and `Basic`/`Bearer` header values. A base URL may carry `user:password@`.
- **A cancelled or overtaken test changes nothing.** Named sections are
  deduplicated, each test has a deadline, and the call's cancellation signal
  reaches the HTTP requests of every test that makes them directly. The rest
  (Confluence, Google, Slack) only read, so an abandoned one ends at its own
  request timeouts. OpenAI-compatible discovery checks cancellation right before
  it stores models, and stores them only if the endpoint and key are still the
  ones it asked, keeping any change saved meanwhile. Progress is streamed after
  each test.

A stored credential stays with the URL origin (scheme, host and port) it was
entered or connected for (`app/server/src/urlOrigin.ts`). Saving a URL on
another origin drops it in the same write, unless that write also carries a new
one: the Forgejo token, the OpenAI-compatible API key, and the Tempo connection.
Otherwise anyone who can change a URL, the Personal Assistant included, could
have the next call or connection test send a secret they cannot read to a host
they choose. A path change on the same origin keeps the credential. This holds
for the Settings page too, whose URL fields say so; its forms send the URL and a
re-entered token in one save. An integration added later with a configurable URL
and a stored credential must do the same in its store.

The Google and Tempo token refreshes, which every tool and test go through,
store a refreshed token only while the stored refresh token is still the one the
request used. A refresh that returns after a disconnect therefore cannot
reconnect the account. The Tempo OAuth callback likewise stores its grant onto
the settings as they are when the token arrives, and only while its pending
state is still stored, so a disconnect or API move saved meanwhile stands. A
refresh is not cancelled mid-request: the provider may already have rotated the
refresh token, and dropping the answer would lose the grant.

Settings-file read errors never quote the file: a `JSON.parse` failure reads
"the file is not valid JSON" (`fileReadErrorText` in `errors.ts`), because the
quoted text could be a token.

## Google sign-in

Google consent runs in a browser, not the native shell's embedded webview.
Browsers open `/api/google/oauth/start` synchronously from the click. A blocked
popup is reported on the sign-in surface, not treated as a completed attempt.
Native shells first POST to the token- and origin-guarded
`/api/google/oauth/prepare`, which returns the Google consent URL with
`Cache-Control: no-store`. A typed native helper sends the pinned Google URL
through the shell's foreign-navigation guard, which opens the system browser and
keeps the app page intact. This avoids popup restrictions after the fetch. The
endpoint accepts no caller-supplied redirect or scope; it uses the same
server-generated state and callback origin as the browser start route.

The callback stores authorization and announces the updated settings even when
there is no popup opener. Google settings rechecks the connection on focus or
visibility return from the external browser. Connection cards use the same
sign-in helper and resolve through the server's connection announcement. No
native rebuild is required for shells with the foreign-navigation guard.

## Cards for secrets and connections

`settings_request_input` raises a `settingsInput` approval card for a `secret`
or `oauth` setting and ends the turn (`app/server/src/settingsInput.ts`,
`app/web/src/components/SettingsInputApprovalBody.tsx`):

- **Secret**: the card shows a password field. Save sends the value in the
  approving decision's `edits` (`SettingsInputResolutionEdits`) and nowhere
  else. The executor's `prepare` checks it and holds it in memory for that one
  resolution; `execute` writes it through `saveSettings` and runs the section's
  connection test. The stored card, the outcome the agent reads and every client
  see only "saved" and the server-written test result. A failed save is reported
  in the server's words too, since a writer's or side effect's message may carry
  the value in some encoding. The executor's `release` drops the held value
  however the resolution ends, including a failure between `prepare` and
  `execute`. An approval without a value is refused and the card stays pending.
  In the browser the field lives in a component mounted only while the card
  waits, so a dismissed, answered or replaced card keeps no typed value.
- **Connect**: the card opens the descriptor's `connectPath` (the server's OAuth
  start route) in a popup, or Google's system-browser flow in a native shell.
  The card cannot be approved before the account is connected; when the OAuth
  callback announces its section, every pending connection card it satisfied is
  approved and its outcome handed to the session. A connection the deployment
  has no OAuth client for is refused when asked for. Google
  (`google.connection`), Tempo (`tempo.connection`) and Slack
  (`slack.connection`) connect this way. Slack's OAuth stores a user and a bot
  token together, so its projection reports `slack.connected` only when both are
  present, and its `disconnect` patch flag clears both.

The card has no grant key, so "approve for session" never covers it. Asking
again for the same setting supersedes the earlier card. Claude and OpenAI
accounts sign in through the same card in `signIn` mode (see Accounts).

## Accounts

The Claude and OpenAI accounts models run on are credential profiles
(`app/server/src/credentialProfiles.ts`), kept outside the settings registry.
The Personal Assistant reaches them through three tools in the same `settings`
group, which call the functions the Settings page's `/api/credential-profiles`
routes call:

- `accounts_read`: each account's id, name, provider, enabled state and sign-in
  status, the settings that pin it, how many sessions are bound to it, and
  whether it takes its provider's unpinned work. A login in progress never shows
  its device code or link here.
- `accounts_update`: create, rename, enable, disable or delete. Delete refuses a
  default account or one a session is bound to, as the page does, and unpins the
  account from every setting through `clearProfilePins`.
- `accounts_sign_in`: raises a `settingsInput` card in `signIn` mode
  (`path: accounts.<id>`, `account: { id, provider }`) and ends the turn. In the
  browser an OpenAI account starts its device login and shows the link and code
  there; a Claude account opens the official CLI login terminal. The card cannot
  be approved before the account is ready. `credentialProfiles.ts` announces
  every account change (`subscribeCredentialProfileChanges`: created, renamed,
  enabled, deleted, login state moved), and a sign-in card for an account that
  is now enabled and signed in is approved and its outcome handed to the
  session. An OpenAI login counts as done once its credential file changes,
  which nothing announces, so `watchSignInCards` also re-checks waiting sign-in
  cards every few seconds while any waits, and once at boot for cards a restart
  left waiting. An account that is already signed in gets no card: the tool
  reports it, since a new login would satisfy a card with the old credential
  before the new one exists.
- An account's raw login error is the provider's text and can quote a device
  code, link or token, so the tools never return it: an account in `error`
  status carries a server-written note pointing at its Settings page, which
  shows the error to the user.

## The Settings page and the registry

Each Settings section is hand-written: grouping, descriptions and controls that
depend on each other. Below it, `RegistrySettingFields`
(`app/web/src/components/RegistrySettingFields.tsx`) renders every setting of
the section that the section's own UI does not claim, from its descriptor's
label, hint, kind and bounds: a toggle, a select for an enum (a stored value
outside the choices, or none, shows as such rather than as the first choice),
the value of a read-only setting, or a text or number field. A text or number
field is edited freely and saved on blur or Enter (Escape discards); a number is
validated, rounded and clamped to its bounds only then. While the user is
editing, a value arriving from the server (another tab, the assistant, the echo
of an earlier save) never replaces what they typed. Writes go through the page's
ordinary settings patch, built by `writeAppSettingAt`, the same helper the agent
write path uses. So a setting added to the registry appears on the page, and to
the Personal Assistant, with no other change.

`app/web/src/components/settingsClaims.ts` lists the paths the hand-written
sections render (`RENDERED_SETTING_PATHS`) and the ones no section shows on
purpose, each with its reason (`OMITTED_SETTING_PATHS`: OAuth redirect URIs and
scopes, Slack's manual tokens). Its tests require every claimed path to be a
real setting, and every setting that needs hand-built UI (a secret, an OAuth
connection, a `json` value, a writable field of an integration section, which
saves through its own flow) to be claimed. `INTEGRATION_SETTINGS_SECTIONS` in
the registry names the integration sections; a server test keeps it equal to the
service's integration writers.
