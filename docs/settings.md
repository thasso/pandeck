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
    discovered account email). Shown, never written.
  - `secret`: write-only. A read reports only the `configuredBy` flag. Writing
    `null` sets the `clearWith` patch flag.
  - `oauth`: connected through a browser flow. Only `null` (disconnect, via
    `clearWith`) can be written.
- `value`: the kind and bounds a write must have. A `json` value (a model list,
  the peer runtime roster, skill toggles, the dictation vocabulary) is written
  whole and checked by `appSettingsPatchError` in `validateClientMessage.ts`,
  the same check the socket message gets.
- `optional`: writing `""` removes the field, for example an account pin back to
  automatic.

A section with nothing in the registry, or that shows something the registry
does not hold, says what and where in `SETTINGS_OUTSIDE_REGISTRY`: Claude and
OpenAI accounts are credential profiles, push subscriptions and port forwards
belong to a device, and the About page has nothing to set.

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
| `dayScan`, `profile`  | Re-arm the daily scan schedule                                                                          |
| `slack`               | Reconcile Socket Mode                                                                                   |
| `github`              | Reconcile the package proxy                                                                             |
| `openAiCompatible`    | Sync the configured model providers                                                                     |
| any other integration | `notifyIntegrationToolsChanged` (live `tools/list_changed`)                                             |

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
touches `permanentAssistant`, so one unreadable integration file never blocks
saving an unrelated section.

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
